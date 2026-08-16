import { Router } from 'express'
import { createLogger } from '../lib/logger'
import { fetchSingleTokenPrice, type ProviderName } from '../lib/priceProviders'
import { getRedis } from '../lib/redis'

const router = Router()
const log = createLogger('routes:prices')

// Fresh key = short TTL so consecutive hits inside a minute short-circuit
// the upstream fetch. Stale key = long TTL so if CMC is degraded we can
// still serve the last-known price with an X-Stale header instead of a
// hard 502 that forces the wallet to a hardcoded $3050 fallback.
const CACHE_KEY_FRESH = 'price:xaut:usd:fresh'
const CACHE_KEY_STALE = 'price:xaut:usd:stale'
const FRESH_TTL_SECONDS = 60
const STALE_TTL_SECONDS = 24 * 60 * 60

interface CachedPayload {
  symbol: 'XAUT'
  vs: 'usd'
  priceUsd: number
  asOf: string
  // Which tier of the priceProviders waterfall served this price. Persisted
  // in the cache payload so subsequent fresh-cache hits can still emit the
  // X-Provider-Source header. Optional to stay backwards-compatible with
  // stale keys written before this field existed.
  source?: ProviderName
}

function staleAgeSeconds(asOf: string): number {
  const asOfMs = new Date(asOf).getTime()
  if (!Number.isFinite(asOfMs)) return 0
  const ageMs = Date.now() - asOfMs
  return Math.max(0, Math.floor(ageMs / 1000))
}

router.get('/api/prices/xaut', async (req, res) => {
  const vs = (req.query.vs ?? 'usd').toString().toLowerCase()
  if (vs !== 'usd') {
    return res.status(400).json({ error: 'only vs=usd supported' })
  }

  const cache = getRedis()

  // Fast path: fresh cache hit. Cache-Control matches the FRESH_TTL_SECONDS
  // so intermediaries (mobile OS network layer, HTTP proxies) may
  // short-circuit repeat calls within the same minute. Cache header set
  // BEFORE the JSON write so it lands on the response.
  try {
    const cached = await cache?.get(CACHE_KEY_FRESH)
    if (cached) {
      const parsed = JSON.parse(cached) as CachedPayload
      res.setHeader('Cache-Control', `max-age=${FRESH_TTL_SECONDS}`)
      if (parsed.source) res.setHeader('X-Provider-Source', parsed.source)
      return res.json(parsed)
    }
  } catch (err) {
    log.warn('redis fresh read failed:', err instanceof Error ? err.message : err)
  }

  // Slow path: try upstream via multi-provider waterfall (DIA -> CoinGecko
  // -> CMC -> hardcoded). Sole-CMC dependency removed 2026-08-15; XAUt now
  // benefits from DIA-first (free, no quota) and CG fallback before CMC.
  try {
    const fresh = await fetchSingleTokenPrice('XAUt')
    if (!fresh) throw new Error('no provider returned a price for XAUt')
    const payload: CachedPayload = {
      symbol: 'XAUT',
      vs: 'usd',
      priceUsd: fresh.priceUsd,
      asOf: new Date(fresh.fetchedAtMs).toISOString(),
      source: fresh.source,
    }
    // Write both keys so the stale copy survives upstream outages longer
    // than the fresh TTL. Failures on either write are non-fatal; the
    // request still returns the fresh payload.
    try {
      await cache?.set(
        CACHE_KEY_FRESH,
        JSON.stringify(payload),
        'EX',
        FRESH_TTL_SECONDS,
      )
    } catch (err) {
      log.warn(
        'redis fresh write failed:',
        err instanceof Error ? err.message : err,
      )
    }
    try {
      await cache?.set(
        CACHE_KEY_STALE,
        JSON.stringify(payload),
        'EX',
        STALE_TTL_SECONDS,
      )
    } catch (err) {
      log.warn(
        'redis stale write failed:',
        err instanceof Error ? err.message : err,
      )
    }
    res.setHeader('Cache-Control', `max-age=${FRESH_TTL_SECONDS}`)
    res.setHeader('X-Provider-Source', fresh.source)
    return res.json(payload)
  } catch (err) {
    log.warn('upstream error:', err instanceof Error ? err.message : err)
    // Upstream down: try to serve the last-known-good price from the
    // long-TTL stale key. Better than a 502 that pushes the wallet to a
    // hardcoded fallback that drifts from the real market. X-Stale +
    // X-Stale-Age lets the wallet render a "cotizacion desactualizada"
    // badge. `Cache-Control: max-age=0, must-revalidate` prevents
    // intermediaries from caching the stale value further.
    try {
      const staleRaw = await cache?.get(CACHE_KEY_STALE)
      if (staleRaw) {
        const stale = JSON.parse(staleRaw) as CachedPayload
        res.setHeader('X-Stale', 'true')
        res.setHeader('X-Stale-Age', String(staleAgeSeconds(stale.asOf)))
        res.setHeader('X-Provider-Source', 'stale-cache')
        res.setHeader('Cache-Control', 'max-age=0, must-revalidate')
        return res.json(stale)
      }
    } catch (staleErr) {
      log.warn(
        'redis stale read failed:',
        staleErr instanceof Error ? staleErr.message : staleErr,
      )
    }
    return res.status(502).json({ error: 'upstream price feed unavailable' })
  }
})

export default router
