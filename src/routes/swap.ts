import { Router, Request, Response } from 'express'
import { createLogger } from '../lib/logger'
import { NATIVE_TOKEN_SENTINEL, networkIdToChainId } from '../lib/networks'
import { buildCacheKey } from '../lib/query'
import { getRedis } from '../lib/redis'
import { squidRoute, SquidRouteResponse } from '../lib/squid'

const router = Router()
const log = createLogger('routes:swap')

const CACHE_TTL_SECONDS = 30
const DEFAULT_SLIPPAGE = '0.5'

const ALLOWED_PARAMS = new Set([
  'buyToken',
  'buyIsNative',
  'buyNetworkId',
  'sellToken',
  'sellIsNative',
  'sellNetworkId',
  'sellAmount',
  'userAddress',
  'slippagePercentage',
])

const ADDRESS_RE = /^0x[a-f0-9]{40}$/
const NETWORK_ID_RE = /^[a-z0-9-]+$/
const DECIMAL_RE = /^\d+(\.\d+)?$/
const INT_DECIMAL_RE = /^\d+$/

interface ValidatedInput {
  buyToken: string
  buyIsNative: boolean
  buyNetworkId: string
  sellToken: string
  sellIsNative: boolean
  sellNetworkId: string
  sellAmount: string
  userAddress: string
  slippage: number
  fromChainId: number
  toChainId: number
}

function validate(req: Request): { ok: true; input: ValidatedInput } | { ok: false; error: string } {
  for (const key of Object.keys(req.query)) {
    if (!ALLOWED_PARAMS.has(key)) {
      return { ok: false, error: `unknown param: ${key}` }
    }
  }

  const get = (k: string): string | undefined => {
    const v = req.query[k]
    return typeof v === 'string' ? v : undefined
  }

  const buyToken = get('buyToken')
  const buyIsNativeRaw = get('buyIsNative')
  const buyNetworkId = get('buyNetworkId')
  const sellToken = get('sellToken')
  const sellIsNativeRaw = get('sellIsNative')
  const sellNetworkId = get('sellNetworkId')
  const sellAmount = get('sellAmount')
  const userAddress = get('userAddress')
  const slippagePercentage = get('slippagePercentage') ?? DEFAULT_SLIPPAGE

  if (!buyToken || !ADDRESS_RE.test(buyToken)) return { ok: false, error: 'invalid buyToken' }
  if (buyIsNativeRaw !== 'true' && buyIsNativeRaw !== 'false')
    return { ok: false, error: 'invalid buyIsNative' }
  if (!buyNetworkId || !NETWORK_ID_RE.test(buyNetworkId))
    return { ok: false, error: 'invalid buyNetworkId' }
  if (!sellToken || !ADDRESS_RE.test(sellToken)) return { ok: false, error: 'invalid sellToken' }
  if (sellIsNativeRaw !== 'true' && sellIsNativeRaw !== 'false')
    return { ok: false, error: 'invalid sellIsNative' }
  if (!sellNetworkId || !NETWORK_ID_RE.test(sellNetworkId))
    return { ok: false, error: 'invalid sellNetworkId' }
  if (!sellAmount || !INT_DECIMAL_RE.test(sellAmount))
    return { ok: false, error: 'invalid sellAmount' }
  if (!userAddress || !ADDRESS_RE.test(userAddress))
    return { ok: false, error: 'invalid userAddress' }
  if (!DECIMAL_RE.test(slippagePercentage))
    return { ok: false, error: 'invalid slippagePercentage' }

  const slippage = Number(slippagePercentage)
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 100)
    return { ok: false, error: 'invalid slippagePercentage' }

  const fromChainId = networkIdToChainId(sellNetworkId)
  const toChainId = networkIdToChainId(buyNetworkId)
  if (fromChainId === undefined) return { ok: false, error: `unsupported sellNetworkId: ${sellNetworkId}` }
  if (toChainId === undefined) return { ok: false, error: `unsupported buyNetworkId: ${buyNetworkId}` }

  return {
    ok: true,
    input: {
      buyToken,
      buyIsNative: buyIsNativeRaw === 'true',
      buyNetworkId,
      sellToken,
      sellIsNative: sellIsNativeRaw === 'true',
      sellNetworkId,
      sellAmount,
      userAddress,
      slippage,
      fromChainId,
      toChainId,
    },
  }
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
  const guaranteedPrice =
    toAmountMin && Number(fromAmount) > 0
      ? (Number(toAmountMin) / Number(fromAmount)).toString()
      : price

  const swapTx: Record<string, unknown> = {
    swapType,
    chainId: input.fromChainId,
    buyAmount: toAmount,
    sellAmount: fromAmount,
    buyTokenAddress: input.buyToken,
    sellTokenAddress: input.sellToken,
    price,
    guaranteedPrice,
    appFeePercentageIncludedInPrice: undefined,
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
        slippage: input.slippage,
        quoteOnly: false,
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
    res.status(502).json({ error: 'squid upstream unavailable' })
  }
})

export default router
