// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Squid quote proxy".
// Public docs: `docs/api.md` section "GET /api/swap/quote". Any change to wire
// shape or kill switches here must update both.
import { Router, Request, Response } from 'express'
import { createLogger } from '../lib/logger'
import { NATIVE_TOKEN_SENTINEL, networkIdToChainId } from '../lib/networks'
import { buildCacheKey } from '../lib/query'
import { getRedis } from '../lib/redis'
import { Sentry } from '../lib/sentry'
import {
  squidRoute,
  SquidCollectFees,
  SquidRouteResponse,
  SquidUpstreamError,
} from '../lib/squid'
import {
  getUniswapV4Quote,
  isUsdtCopmPair,
  type UniswapV4Direction,
} from '../lib/uniswapV4'
import {
  buildEip7702BatchedSwapCalls,
  buildPermit2TypedData,
  buildSafeErc20ApproveCalls,
  CELO_CHAIN_ID,
  getErc20Allowance,
  getPermit2AllowanceInfo,
  isEip7702Delegated,
  PERMIT2_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
} from '../lib/uniswapV4Executor'
import { firstZodIssueAsError } from './schemas/common'
import {
  swapQuoteQuerySchema,
  type SwapQuoteInput,
} from './schemas/swap'
import buildTxRouter from './swap/build-tx'
import { computeExchangeRate, computeGuaranteedPrice } from './swap/pricing'

const router = Router()
const log = createLogger('routes:swap')

const CACHE_TTL_SECONDS = 30

// Internal validated input. Same as zod-inferred type plus the resolved
// fromChainId / toChainId derived after the schema parse.
interface ValidatedInput extends SwapQuoteInput {
  fromChainId: number
  toChainId: number
}

function validate(req: Request): { ok: true; input: ValidatedInput } | { ok: false; error: string } {
  // zod strict() rejects unknown query params. Convert "Unrecognized key"
  // issues to the canonical "unknown param" message so the response shape
  // matches the pre-zod behaviour (no echo of param name).
  const parsed = swapQuoteQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    if (firstIssue?.code === 'unrecognized_keys') {
      return { ok: false, error: 'unknown param' }
    }
    return { ok: false, error: firstZodIssueAsError(parsed.error) }
  }

  const fromChainId = networkIdToChainId(parsed.data.sellNetworkId)
  const toChainId = networkIdToChainId(parsed.data.buyNetworkId)
  // Same rationale as unknown-param: don't echo the slug in the error.
  if (fromChainId === undefined) return { ok: false, error: 'unsupported sellNetworkId' }
  if (toChainId === undefined) return { ok: false, error: 'unsupported buyNetworkId' }

  return {
    ok: true,
    input: { ...parsed.data, fromChainId, toChainId },
  }
}

// Reads the 3 integrator-fee env vars each call so a Railway env flip takes
// effect on the next request without a redeploy (matching the pattern used
// for SQUID_INTEGRATOR_ID and REDIS_URL). Returns undefined when the kill
// switch is off, which makes the caller skip both the request-side
// collectFees payload AND the response-side appFeePercentageIncludedInPrice
// mapping. Env-var validation in lib/env.ts guarantees that when the flag
// is on, address + percentage are both present and well-formed, so this
// helper does not need runtime defensiveness beyond the flag check.
function resolveCollectFeesFromEnv(): SquidCollectFees | undefined {
  if (process.env.ENABLE_SQUID_INTEGRATOR_FEES !== 'true') return undefined
  const address = process.env.SQUID_INTEGRATOR_FEE_ADDRESS
  const percentage = process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE
  if (!address || !percentage) return undefined
  return {
    integratorAddress: address as `0x${string}`,
    feeType: 'percentage',
    feeValue: Number(percentage),
  }
}

function shapeResponse(
  upstream: SquidRouteResponse,
  input: ValidatedInput,
  collectFees: SquidCollectFees | undefined,
): unknown {
  const swapType: 'same-chain' | 'cross-chain' =
    input.sellNetworkId === input.buyNetworkId ? 'same-chain' : 'cross-chain'

  const est = upstream.route?.estimate ?? {}
  const tx = upstream.route?.transactionRequest ?? {}

  const fromAmount = est.fromAmount ?? input.sellAmount
  const toAmount = est.toAmount ?? '0'
  const toAmountMin = est.toAmountMin

  const price = est.exchangeRate ?? '0'
  const guaranteedPrice = computeGuaranteedPrice(toAmountMin, toAmount, price)

  const swapTx: Record<string, unknown> = {
    swapType,
    chainId: input.fromChainId,
    buyAmount: toAmount,
    sellAmount: fromAmount,
    buyTokenAddress: input.buyToken,
    sellTokenAddress: input.sellToken,
    price,
    guaranteedPrice,
    estimatedPriceImpact: est.aggregatePriceImpact ?? null,
    gas: tx.gasLimit ?? '0',
    estimatedGasUse: est.gasCosts?.[0]?.limit ?? null,
    to: tx.target ?? '',
    value: tx.value ?? '0',
    data: tx.data ?? '0x',
    from: tx.from ?? input.userAddress,
    allowanceTarget: tx.target ?? '',
  }

  if (swapType === 'cross-chain') {
    const totalFees = (est.feeCosts ?? []).reduce(
      (sum, fc) => sum + (fc.amount ? BigInt(fc.amount) : 0n),
      0n,
    )
    swapTx.estimatedDuration = est.estimatedRouteDuration ?? 0
    swapTx.estimatedCrossChainFee = totalFees.toString()
    swapTx.maxCrossChainFee = totalFees.toString()
  }

  // Only surface the integrator-fee percentage to the wallet when the flag
  // is ON. Prefer Squid's echo (source of truth for what actually got applied
  // to the route) over our request-side config (what we ASKED for); if
  // Squid did not echo but we know the fee was requested, fall back to our
  // config value so the wallet still renders a fee line and matches what the
  // user will be charged. Absent field when flag off = wire shape identical
  // to today, backwards compatible.
  if (collectFees) {
    const echoed = est.appFeePercentageIncludedInPrice
    swapTx.appFeePercentageIncludedInPrice =
      echoed ?? collectFees.feeValue.toString()
  }

  // Pre-computed max wei of sell token the router might pull for this quote.
  // For Squid sell-mode quotes (which is how we always call Squid) this is
  // fromAmount itself - the router never pulls more than the user's supplied
  // sellAmount. Exposed as a dedicated field so wallets do NOT have to
  // derive it from `buyAmount * guaranteedPrice`, a formula that only holds
  // for same-decimal pairs and breaks by 10^(sellDec - buyDec) on cross-
  // decimal pairs. Wallet-side approve() should size on this field.
  return {
    unvalidatedSwapTransaction: swapTx,
    details: {
      swapProvider: 'squid',
      worstCaseSellAmount: fromAmount,
    },
  }
}

// Shapes the Fase 2 Uniswap V4 response returned when the executor flag is
// on and either (a) Uniswap wins price on the USDT<->COPm pair, or (b) Squid
// upstream failed. The wire shape preserves the Squid `unvalidatedSwapTransaction`
// fields wallets already read (buyAmount, sellAmount, price, guaranteedPrice,
// gas, to, from, value, allowanceTarget) plus a `data: '0x'` sentinel + a new
// `details.permit2` bundle instructing the wallet to sign + POST /build-tx.
//
// `data === '0x'` is intentional: with the Uniswap path the final calldata
// cannot be built until the user signs the Permit2 typed data. Wallets that
// blindly submit the response without signing/posting to /build-tx will
// bounce with an on-chain revert (execute() rejects an empty payload). This
// keeps the wire delta minimal (one extra field) without silently allowing
// non-integrated wallets to submit broken transactions.
async function shapeUniswapV4Response(input: {
  direction: UniswapV4Direction
  userAddress: `0x${string}`
  sellAmount: string // uint256 decimal string
  sellToken: `0x${string}`
  buyToken: `0x${string}`
  slippagePercentage: number // 0..100
  uniswapAmountOut: bigint
  uniswapGasEstimate: bigint
  collectFees: SquidCollectFees | undefined
  quoteOnly: boolean
}): Promise<unknown> {
  const sellAmountBn = BigInt(input.sellAmount)
  // Slippage-adjusted floor for the OUTPUT token. Same convention as
  // Squid's toAmountMin (subtract slippage% from the quoted amountOut).
  const slippageBps = Math.max(0, Math.round(input.slippagePercentage * 100))
  const grossAmountOut = input.uniswapAmountOut
  const grossMinOut = (grossAmountOut * BigInt(10000 - slippageBps)) / 10000n
  // Fee comes off the OUTPUT token via TAKE_PORTION. The user's floor
  // after the fee is (grossMinOut * (10000 - feeBips) / 10000).
  const feeBips =
    input.collectFees && input.collectFees.feeType === 'percentage'
      ? Math.max(0, Math.round(input.collectFees.feeValue * 100))
      : 0
  const minBuyAmount =
    feeBips > 0
      ? (grossMinOut * BigInt(10000 - feeBips)) / 10000n
      : grossMinOut
  const netAmountOut =
    feeBips > 0
      ? (grossAmountOut * BigInt(10000 - feeBips)) / 10000n
      : grossAmountOut

  // Permit2 nonce for this (user, sellToken, UniversalRouter) triple.
  // If the allowance is fresh AND large enough AND not expired, the wallet
  // MAY skip signing and just submit the swap through a shortened path.
  // We surface `existingAllowance` so the wallet can decide; either way
  // we hand the wallet a typed data to sign for the safe path (fresh nonce
  // is always valid to sign since Permit2 rejects reuse anyway).
  let existingAllowance = { amount: '0', expiration: 0, nonce: 0 }
  let nonce = 0
  try {
    const info = await getPermit2AllowanceInfo(
      input.userAddress,
      input.sellToken,
    )
    existingAllowance = {
      amount: info.amount.toString(),
      expiration: info.expiration,
      nonce: info.nonce,
    }
    nonce = info.nonce
  } catch (err) {
    log.warn(
      'permit2 allowance read failed, using nonce=0 fallback:',
      err instanceof Error ? err.message : err,
    )
  }

  // sigDeadline: give the user 5 minutes to sign the typed data.
  // permitExpiration: 1 year (matches Uniswap Interface convention;
  // the allowance is reusable during this window).
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const sigDeadline = nowSec + 300n // 5 min
  const permitExpiration = Number(nowSec + 365n * 24n * 3600n)
  // permitAmount: exact sellAmount. Bounds user's exposure to precisely
  // this trade even if the signature leaks. NOT MAX_UINT160 by design.
  const permitAmount = sellAmountBn

  const typedData = buildPermit2TypedData({
    token: input.sellToken,
    amount: permitAmount,
    expiration: permitExpiration,
    nonce,
    sigDeadline,
  })

  // Token decimals for the USDT<->COPm pair. USDT is 6, COPm is 18. The
  // `price` field must be human-readable (whole/whole), NOT wei/wei; the
  // wallet renderer bails on magnitudes that do not match the sellToken
  // amount in whole units.
  const [sellDecimals, buyDecimals] =
    input.direction === 'USDT_TO_COPM' ? [6, 18] : [18, 6]
  const price =
    grossAmountOut === 0n
      ? '0'
      : computeExchangeRate(
          grossAmountOut,
          buyDecimals,
          sellAmountBn,
          sellDecimals,
        )
  const guaranteedPrice =
    minBuyAmount === 0n
      ? '0'
      : computeExchangeRate(
          minBuyAmount,
          buyDecimals,
          sellAmountBn,
          sellDecimals,
        )

  // EIP-7702 delegation detection. TuCop wallets are smart wallets
  // delegated to BatchExecutor, which does NOT implement ERC1271
  // isValidSignature. Permit2's SignatureVerification.verify switches
  // to the ERC1271 path when the caller's `code.length > 0` and reverts
  // silently. To avoid that whole class of failures we skip the Permit2
  // signature flow entirely for delegated users and return an explicit
  // batchCalls array the wallet's BatchExecutor executes atomically
  // (approve to Permit2 + swap through UniversalRouter without
  // PERMIT2_PERMIT). This matches the wallet's existing pattern for
  // Neeru approve+deposit and requires no BatchExecutor contract
  // upgrade. Non-delegated users (unusual for TuCop but possible for
  // third-party consumers of the same API) keep the Permit2 signature
  // flow.
  const isDelegated = await isEip7702Delegated(input.userAddress)

  // Swap tx envelope. Common fields for both branches.
  const swapTx: Record<string, unknown> = {
    swapType: 'same-chain',
    chainId: CELO_CHAIN_ID,
    buyAmount: netAmountOut.toString(),
    sellAmount: input.sellAmount,
    buyTokenAddress: input.buyToken,
    sellTokenAddress: input.sellToken,
    price,
    guaranteedPrice,
    estimatedPriceImpact: null,
    gas: input.uniswapGasEstimate.toString(),
    estimatedGasUse: input.uniswapGasEstimate.toString(),
    to: UNIVERSAL_ROUTER_ADDRESS,
    value: '0',
    // `data: '0x'` is intentional. In BOTH branches the wallet does NOT
    // submit the top-level `unvalidatedSwapTransaction` directly. Delegated
    // users iterate `details.batchCalls`. Non-delegated users sign the
    // typed data + POST `/api/swap/build-tx` to get the final data.
    // Any wallet that blindly submits data:'0x' will revert on-chain.
    data: '0x',
    from: input.userAddress,
    // User approves this address (Permit2) with a standard ERC20 approve.
    // Same for both branches; the difference is in what happens AFTER
    // the ERC20 approve to Permit2 lands.
    allowanceTarget: PERMIT2_ADDRESS,
  }
  if (feeBips > 0) {
    swapTx.appFeePercentageIncludedInPrice = (feeBips / 100).toString()
  }

  // -----------------------------------------------------------------
  // Delegated branch: return batchCalls, no Permit2 signature needed.
  // -----------------------------------------------------------------
  if (isDelegated) {
    // Deadline for the on-chain execute() call. 5 min is plenty for the
    // wallet to sign + submit; also matches the sigDeadline convention
    // from the non-delegated branch.
    const execDeadline = nowSec + 300n
    // Permit2.approve expiration: 1 year, same as the non-delegated
    // `permitExpiration`. This lets the allowance be reused across
    // subsequent swaps in the same window (wallet can skip the approve
    // call on subsequent batches if it detects an unexpired allowance).
    const approveExpiration = Number(nowSec + 365n * 24n * 3600n)

    const batched = buildEip7702BatchedSwapCalls({
      direction: input.direction,
      sellToken: input.sellToken,
      sellAmount: sellAmountBn,
      minBuyAmount,
      deadline: execDeadline,
      approveExpiration,
    })

    // Prepend ERC20 approve to Permit2 when the user's on-chain allowance
    // is insufficient. Without this, batchCall[swap] reverts empty inside
    // SETTLE_ALL because USDT.transferFrom (called by Permit2.transferFrom)
    // requires ERC20 allowance >= sellAmount. Tether-style tokens revert
    // with no error string, which looks like an empty ExecutionFailed
    // inside the BatchExecutor wrap.
    //
    // Bug 3 (2026-08-10): wallet team caught this during first EIP-7702
    // batched smoke test on prod-shaped local backend. Root cause: spec
    // v1 assumed wallet would prepend the ERC20 approve, but that broke
    // the "consume batchCalls verbatim" contract. Fix: backend does the
    // detection + prepend so batchCalls is truly the exact list of calls
    // the wallet's BatchExecutor forwards.
    let erc20Allowance = 0n
    try {
      erc20Allowance = await getErc20Allowance(
        input.sellToken,
        input.userAddress,
        PERMIT2_ADDRESS,
      )
    } catch (err) {
      log.warn(
        'ERC20 allowance read failed, prepending approve defensively:',
        err instanceof Error ? err.message : err,
      )
    }
    const erc20ApproveCalls = buildSafeErc20ApproveCalls(
      input.sellToken,
      PERMIT2_ADDRESS,
      erc20Allowance,
      sellAmountBn,
    )

    return {
      unvalidatedSwapTransaction: swapTx,
      details: {
        swapProvider: 'uniswap-v4',
        worstCaseSellAmount: input.sellAmount,
        // BatchExecutor.execute() consumes THIS array as-is. The wallet
        // does NOT need to prepend anything, check allowances, or split
        // by concern - just forward each entry as a call. The array
        // varies in length based on current on-chain state:
        //   - 2 items: user already has USDT.allowance(user, Permit2) >= sellAmount
        //     -> [Permit2.approve, UniversalRouter.execute]
        //   - 3 items: user has zero ERC20 allowance to Permit2
        //     -> [USDT.approve(Permit2, sellAmount), Permit2.approve, UniversalRouter.execute]
        //   - 4 items: user has non-zero-but-insufficient ERC20 allowance
        //     -> [USDT.approve(Permit2, 0), USDT.approve(Permit2, sellAmount),
        //         Permit2.approve, UniversalRouter.execute]
        //     (Tether-style tokens require the reset-to-zero step.)
        batchCalls: [
          ...erc20ApproveCalls.map((call) => ({
            to: call.to,
            data: call.data,
            value: call.value.toString(),
          })),
          {
            to: batched.approve.to,
            data: batched.approve.data,
            value: batched.approve.value.toString(),
          },
          {
            to: batched.swap.to,
            data: batched.swap.data,
            value: batched.swap.value.toString(),
          },
        ],
      },
    }
  }

  // -----------------------------------------------------------------
  // Non-delegated branch: Permit2 signature + /api/swap/build-tx flow.
  // -----------------------------------------------------------------
  return {
    unvalidatedSwapTransaction: swapTx,
    details: {
      swapProvider: 'uniswap-v4',
      worstCaseSellAmount: input.sellAmount,
      // The wallet MUST:
      //   1. eth_signTypedData_v4 on `permit2.typedData`.
      //   2. If `existingAllowance.amount < sellAmount` OR
      //      `existingAllowance.expiration <= now`, the user first needs to
      //      approve sellToken -> Permit2 (allowanceTarget). Standard ERC20.
      //   3. POST `permit2.buildTxRequest` to `/api/swap/build-tx` filled with
      //      the values below + `permit2Signature: <sig>`. Response is the
      //      final `{to, data, value}` to submit.
      permit2: {
        typedData,
        existingAllowance,
        buildTxUrl: '/api/swap/build-tx',
        // Concrete request body template the wallet fills the signature into.
        buildTxRequest: {
          direction: input.direction,
          userAddress: input.userAddress,
          sellAmount: input.sellAmount,
          minBuyAmount: minBuyAmount.toString(),
          deadline: sigDeadline.toString(),
          permitToken: input.sellToken,
          permitAmount: permitAmount.toString(),
          permitExpiration,
          permitNonce: nonce,
          permitSigDeadline: sigDeadline.toString(),
          // permit2Signature: '<0x + 130 hex from eth_signTypedData_v4>'
        },
      },
    },
  }
}

router.get('/api/swap/quote', async (req: Request, res: Response) => {
  // Read process.env directly (rather than via the zod-frozen env proxy) so
  // tests can flip the value at runtime; zod already validated at boot.
  const integratorId = process.env.SQUID_INTEGRATOR_ID
  if (!integratorId) {
    return res.status(503).json({ error: 'squid integrator id not configured' })
  }

  const v = validate(req)
  if (!v.ok) {
    return res.status(400).json({ error: v.error })
  }
  const { input } = v

  const cache = getRedis()
  // Include the integrator-fee flag state in the cache key so a Railway
  // env flip does NOT serve stale responses across the transition. Without
  // this, a cached quote taken with the flag OFF (no fee applied, no
  // appFeePercentageIncludedInPrice field) could be served for 30s after
  // the flag flipped ON, so the wallet would show no fee line but the user
  // would actually be charged. Same failure in reverse when flipping off.
  // Two suffixes keep the two states in separate cache buckets.
  const feesOn = process.env.ENABLE_SQUID_INTEGRATOR_FEES === 'true'
  const cacheKey = buildCacheKey('squid', req.path, {
    ...(req.query as Record<string, string>),
    _fees: feesOn ? '1' : '0',
  })

  try {
    const cached = await cache?.get(cacheKey)
    if (cached) {
      return res.json(JSON.parse(cached))
    }
  } catch (err) {
    log.warn('redis read failed:', err instanceof Error ? err.message : err)
  }

  const fromToken = input.sellIsNative ? NATIVE_TOKEN_SENTINEL : input.sellToken
  const toToken = input.buyIsNative ? NATIVE_TOKEN_SENTINEL : input.buyToken
  const collectFees = resolveCollectFeesFromEnv()

  // Fase 1 (shadow only): when the pair is USDT<->COPm AND the fallback flag
  // is on, fetch Uniswap V4 Quoter in parallel with Squid so we can log
  // both and see the gap in production data. Nothing user-visible changes:
  // response is still the Squid payload (or the Squid failure). Fase 2 will
  // switch this to actually route via Uniswap V4 when it wins or when Squid
  // fails (needs Permit2 + UniversalRouter calldata construction).
  const uniswapDirection = isUsdtCopmPair(input.sellToken, input.buyToken)
  const uniswapShadowActive =
    uniswapDirection !== null &&
    process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED === 'true'
  // Fase 2 activation flag: when true AND the pair matches AND the
  // shadow flag is on, we may return a Uniswap-V4-flavored response
  // (uniswap-v4 provider + permit2 typed data) instead of the Squid
  // payload. Env refinement rejects active=true without shadow=true, so
  // both preconditions collapse to a single boolean.
  const uniswapExecuteActive =
    uniswapShadowActive &&
    process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE === 'true'
  const uniswapQuotePromise: Promise<
    { amountOut: bigint; gasEstimate: bigint } | null | Error
  > | null = uniswapShadowActive
    ? getUniswapV4Quote(uniswapDirection, BigInt(input.sellAmount)).catch(
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      )
    : null

  try {
    const upstream = await squidRoute(
      {
        fromAddress: input.userAddress,
        fromChain: String(input.fromChainId),
        fromToken,
        fromAmount: input.sellAmount,
        toChain: String(input.toChainId),
        toToken,
        toAddress: input.userAddress,
        slippage: input.slippagePercentage,
        quoteOnly: input.quoteOnly,
        ...(collectFees ? { collectFees } : {}),
      },
      integratorId,
    )

    // Resolve the Uniswap quote alongside the Squid upstream so decision +
    // shadow log share the same result. `uniswapQuotePromise` was launched
    // in parallel with the Squid request above.
    const uniswapResultForDecision = uniswapQuotePromise
      ? await uniswapQuotePromise
      : null

    // Fase 2 decision: when the executor flag is active AND Uniswap has a
    // valid quote AND (Squid failed to price OR Uniswap gave more output),
    // reshape the response to route through Uniswap. Otherwise fall through
    // to the Squid payload as before.
    const squidToAmount = upstream.route?.estimate?.toAmount
    const shouldRouteUniswap =
      uniswapExecuteActive &&
      uniswapResultForDecision !== null &&
      !(uniswapResultForDecision instanceof Error) &&
      uniswapDirection !== null &&
      (!squidToAmount ||
        BigInt(uniswapResultForDecision.amountOut) > BigInt(squidToAmount))

    const payload = shouldRouteUniswap
      ? await shapeUniswapV4Response({
          direction: uniswapDirection!,
          userAddress: input.userAddress as `0x${string}`,
          sellAmount: input.sellAmount,
          sellToken: input.sellToken as `0x${string}`,
          buyToken: input.buyToken as `0x${string}`,
          slippagePercentage: input.slippagePercentage,
          uniswapAmountOut: (
            uniswapResultForDecision as { amountOut: bigint; gasEstimate: bigint }
          ).amountOut,
          uniswapGasEstimate: (
            uniswapResultForDecision as { amountOut: bigint; gasEstimate: bigint }
          ).gasEstimate,
          collectFees,
          quoteOnly: input.quoteOnly,
        })
      : shapeResponse(upstream, input, collectFees)

    // Shadow log for the Uniswap V4 comparison. Emit whenever the pair is
    // USDT<->COPm and the flag is on, regardless of whether Squid succeeded
    // or failed. Uses WARN level for the same reason as the squid_integrator_fee
    // log (INFO is noop'd in prod).
    if (uniswapShadowActive && uniswapResultForDecision !== null) {
      logQuoteComparison({
        squidBuyAmount: squidToAmount ?? null,
        squidError: null,
        uniswapResult: uniswapResultForDecision,
        direction: uniswapDirection!,
        sellAmount: input.sellAmount,
        userAddress: input.userAddress,
        quoteOnly: input.quoteOnly,
      })
    }

    // Structured integrator-fee audit log for on-chain reconciliation.
    // Emitted at WARN level (not INFO) because the project logger noops
    // INFO in production (NODE_ENV=production sets minLevel=warn in
    // src/lib/logger.ts). Every fee-collecting request is a business event
    // that must be captured for reconciliation against the recipient's
    // ERC-20 balance growth on Celoscan; losing it silently in prod would
    // make the whole feature unauditable.
    //
    // Emitted ONLY when the fee is active so quiet swaps stay quiet.
    // Fields chosen so a batch query can cross-check log.sum(feeAmount)
    // against the recipient's balance growth. `feeMatch: false` = Squid
    // applied a different percentage than requested (data-integrity
    // signal - if it clusters, alert externally).
    if (collectFees) {
      const echoed = upstream.route?.estimate?.appFeePercentageIncludedInPrice
      const feeMatch =
        echoed === undefined ? null : Number(echoed) === collectFees.feeValue
      log.warn(
        JSON.stringify({
          event: 'squid_integrator_fee',
          integratorAddress: collectFees.integratorAddress,
          feeType: collectFees.feeType,
          feeValueRequested: collectFees.feeValue,
          feeValueApplied: echoed ?? null,
          feeMatch,
          fromChain: String(input.fromChainId),
          toChain: String(input.toChainId),
          fromToken,
          toToken,
          fromAmount: input.sellAmount,
          userAddress: input.userAddress,
          quoteOnly: input.quoteOnly,
        }),
      )
      // Data-integrity alert: Squid applied a different percentage than
      // requested. Alertable because it means the fee-reconciliation math
      // is off and the recipient balance growth will not match the sum of
      // logged fees. Fire at warning level so a single mismatch does not
      // page but a cluster shows up on the tokens dashboard degradation
      // table (same wiring as tokens_info_unresolved_symbols).
      if (feeMatch === false) {
        Sentry.captureMessage('squid_integrator_fee_mismatch', {
          level: 'warning',
          tags: {
            event: 'squid_integrator_fee_mismatch',
            route: '/api/swap/quote',
            fromToken,
            toToken,
          },
          extra: {
            integratorAddress: collectFees.integratorAddress,
            feeValueRequested: collectFees.feeValue,
            feeValueApplied: echoed ?? null,
            fromAmount: input.sellAmount,
            userAddress: input.userAddress,
          },
        })
      }
    }

    try {
      await cache?.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS)
    } catch (err) {
      log.warn('redis write failed:', err instanceof Error ? err.message : err)
    }

    res.json(payload)
  } catch (err) {
    log.warn('squid upstream error:', err instanceof Error ? err.message : err)
    // Resolve the Uniswap quote (was launched in parallel with Squid) so
    // both the shadow log AND the fallback decision see it.
    const uniswapResultOnSquidFail = uniswapQuotePromise
      ? await uniswapQuotePromise
      : null
    // Emit the shadow comparison even when Squid failed: this is exactly
    // the weekend-Mento pattern we want data on. Captures "Squid returned
    // 502 but Uniswap V4 had a real quote of X COPm", the value-of-Fase-2
    // signal.
    if (uniswapShadowActive && uniswapResultOnSquidFail !== null) {
      logQuoteComparison({
        squidBuyAmount: null,
        squidError:
          err instanceof SquidUpstreamError
            ? `upstream ${err.status}`
            : err instanceof Error
              ? err.message.slice(0, 200)
              : 'unknown',
        uniswapResult: uniswapResultOnSquidFail,
        direction: uniswapDirection!,
        sellAmount: input.sellAmount,
        userAddress: input.userAddress,
        quoteOnly: input.quoteOnly,
      })
    }
    // Fase 2: when the executor flag is on AND Uniswap gave us a quote,
    // serve the Uniswap response even though Squid failed. This is the
    // primary user-benefit of the executor: weekend swaps stop 502ing.
    if (
      uniswapExecuteActive &&
      uniswapResultOnSquidFail !== null &&
      !(uniswapResultOnSquidFail instanceof Error) &&
      uniswapDirection !== null
    ) {
      const payload = await shapeUniswapV4Response({
        direction: uniswapDirection,
        userAddress: input.userAddress as `0x${string}`,
        sellAmount: input.sellAmount,
        sellToken: input.sellToken as `0x${string}`,
        buyToken: input.buyToken as `0x${string}`,
        slippagePercentage: input.slippagePercentage,
        uniswapAmountOut: uniswapResultOnSquidFail.amountOut,
        uniswapGasEstimate: uniswapResultOnSquidFail.gasEstimate,
        collectFees,
        quoteOnly: input.quoteOnly,
      })
      return res.json(payload)
    }
    if (err instanceof SquidUpstreamError && err.status === 429) {
      if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter)
      return res.status(429).json({ error: 'rate limited by squid, retry' })
    }
    res.status(502).json({ error: 'squid upstream unavailable' })
  }
})

// Structured shadow log emitted at WARN level (INFO is noop'd in prod, see
// logger.ts). One line per USDT<->COPm quote request when the fallback flag
// is on. Enables historical analysis of the gap Squid vs Uniswap V4 before
// Fase 2 activates real routing based on best amountOut.
function logQuoteComparison(input: {
  squidBuyAmount: string | null
  squidError: string | null
  uniswapResult: { amountOut: bigint; gasEstimate: bigint } | null | Error
  direction: UniswapV4Direction
  sellAmount: string
  userAddress: string
  quoteOnly: boolean
}): void {
  const uniswap = input.uniswapResult
  const uniswapAmountOut =
    uniswap && !(uniswap instanceof Error) ? uniswap.amountOut.toString() : null
  const uniswapError =
    uniswap instanceof Error ? uniswap.message.slice(0, 200) : null
  // "Winner" is Uniswap iff we have both quotes AND uniswap > squid, or if
  // Squid failed and Uniswap has a quote. Left null when we cannot compare.
  let winner: 'squid' | 'uniswap_v4' | 'neither' | null = null
  if (input.squidBuyAmount && uniswapAmountOut) {
    winner =
      BigInt(uniswapAmountOut) > BigInt(input.squidBuyAmount)
        ? 'uniswap_v4'
        : 'squid'
  } else if (input.squidError && uniswapAmountOut) {
    winner = 'uniswap_v4'
  } else if (input.squidBuyAmount && !uniswapAmountOut) {
    winner = 'squid'
  } else {
    winner = 'neither'
  }
  log.warn(
    JSON.stringify({
      event: 'swap_quote_comparison',
      direction: input.direction,
      sellAmount: input.sellAmount,
      squidBuyAmount: input.squidBuyAmount,
      squidError: input.squidError,
      uniswapAmountOut,
      uniswapError,
      uniswapGasEstimate:
        uniswap && !(uniswap instanceof Error)
          ? uniswap.gasEstimate.toString()
          : null,
      winner,
      userAddress: input.userAddress,
      quoteOnly: input.quoteOnly,
    }),
  )
}

// The POST /api/swap/build-tx endpoint (Fase 2 Uniswap V4 executor) lives
// in its own module to keep this file focused on the Squid + V4 quote
// path. Mounted as a sub-router so `import router from './swap'` still
// serves both endpoints.
router.use(buildTxRouter)

export default router
