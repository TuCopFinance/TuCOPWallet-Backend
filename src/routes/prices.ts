import { Router } from 'express'
import { getXautPriceUsd } from '../lib/coinmarketcap'
import { createLogger } from '../lib/logger'
import { getRedis } from '../lib/redis'

const router = Router()
const log = createLogger('routes:prices')
const CACHE_KEY = 'price:xaut:usd'
const TTL_SECONDS = 60

router.get('/api/prices/xaut', async (req, res) => {
  const vs = (req.query.vs ?? 'usd').toString().toLowerCase()
  if (vs !== 'usd') {
    return res.status(400).json({ error: 'only vs=usd supported' })
  }

  const cache = getRedis()
  try {
    const cached = await cache?.get(CACHE_KEY)
    if (cached) {
      return res.json(JSON.parse(cached))
    }
  } catch (err) {
    log.warn('redis read failed:', err instanceof Error ? err.message : err)
  }

  try {
    const fresh = await getXautPriceUsd()
    const payload = {
      symbol: 'XAUT',
      vs: 'usd',
      priceUsd: fresh.priceUsd,
      asOf: fresh.asOf,
    }
    try {
      await cache?.set(CACHE_KEY, JSON.stringify(payload), 'EX', TTL_SECONDS)
    } catch (err) {
      log.warn('redis write failed:', err instanceof Error ? err.message : err)
    }
    res.json(payload)
  } catch (err) {
    log.warn('upstream error:', err instanceof Error ? err.message : err)
    res.status(502).json({ error: 'upstream price feed unavailable' })
  }
})

export default router
