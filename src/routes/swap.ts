import { Router, Request, Response } from 'express'
import { createLogger } from '../lib/logger'
import { NATIVE_TOKEN_SENTINEL, networkIdToChainId } from '../lib/networks'
import { buildCacheKey } from '../lib/query'
import { getRedis } from '../lib/redis'
import { squidRoute, SquidRouteResponse, SquidUpstreamError } from '../lib/squid'
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

function shapeResponse(upstream: SquidRouteResponse, input: ValidatedInput): unknown {
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
  const cacheKey = buildCacheKey('squid', req.path, req.query as Record<string, string>)

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
      },
      integratorId,
    )

    const payload = shapeResponse(upstream, input)

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
