// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Squid quote proxy".
// Public docs: `docs/api.md` section "GET /api/swap/quote". Any change to wire
// shape or kill switches here must update both.
import { Router, Request, Response } from 'express'
import { createLogger } from '../lib/logger'
import { NATIVE_TOKEN_SENTINEL, networkIdToChainId } from '../lib/networks'
import { buildCacheKey } from '../lib/query'
import { getRedis } from '../lib/redis'
import {
  squidRoute,
  SquidCollectFees,
  SquidRouteResponse,
  SquidUpstreamError,
} from '../lib/squid'
import { firstZodIssueAsError } from './schemas/common'
import { swapQuoteQuerySchema, type SwapQuoteInput } from './schemas/swap'

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

const PRICE_SCALE = 1_000_000_000_000_000_000n // 1e18

function safeBigInt(value: string | undefined): bigint | null {
  if (!value) return null
  try {
    const v = BigInt(value)
    return v >= 0n ? v : null
  } catch {
    return null
  }
}

function computeGuaranteedPrice(
  toAmountMin: string | undefined,
  fromAmount: string,
  fallback: string,
): string {
  const min = safeBigInt(toAmountMin)
  const from = safeBigInt(fromAmount)
  if (min === null || from === null || from === 0n) return fallback
  const scaled = (min * PRICE_SCALE) / from
  const whole = scaled / PRICE_SCALE
  const frac = (scaled % PRICE_SCALE).toString().padStart(18, '0').replace(/0+$/, '')
  return frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`
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
  // Use bigint fixed-point (1e18 scale) to keep precision on token amounts
  // above 2^53 wei. `Number(...) / Number(...)` lost precision above ~9 USDT.
  const guaranteedPrice = computeGuaranteedPrice(toAmountMin, fromAmount, price)

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

  return {
    unvalidatedSwapTransaction: swapTx,
    details: { swapProvider: 'squid' },
  }
}

router.get('/api/swap/quote', async (req: Request, res: Response) => {
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
  // the flag flipped ON — the wallet would show no fee line but the user
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

    const payload = shapeResponse(upstream, input, collectFees)

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
      log.warn(
        JSON.stringify({
          event: 'squid_integrator_fee',
          integratorAddress: collectFees.integratorAddress,
          feeType: collectFees.feeType,
          feeValueRequested: collectFees.feeValue,
          feeValueApplied: echoed ?? null,
          feeMatch: echoed === undefined ? null : Number(echoed) === collectFees.feeValue,
          fromChain: String(input.fromChainId),
          toChain: String(input.toChainId),
          fromToken,
          toToken,
          fromAmount: input.sellAmount,
          userAddress: input.userAddress,
          quoteOnly: input.quoteOnly,
        }),
      )
    }

    try {
      await cache?.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS)
    } catch (err) {
      log.warn('redis write failed:', err instanceof Error ? err.message : err)
    }

    res.json(payload)
  } catch (err) {
    log.warn('squid upstream error:', err instanceof Error ? err.message : err)
    if (err instanceof SquidUpstreamError && err.status === 429) {
      if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter)
      return res.status(429).json({ error: 'rate limited by squid, retry' })
    }
    res.status(502).json({ error: 'squid upstream unavailable' })
  }
})

export default router
