import { Router, Request, Response } from 'express'
import { blockscoutGet } from '../lib/blockscout'
import { HEX_ADDRESS_RE, HEX_BYTES32_RE } from '../lib/hex'
import { createLogger } from '../lib/logger'
import { buildCacheKey, stripReservedParams } from '../lib/query'
import { getRedis } from '../lib/redis'

const router = Router()
const log = createLogger('routes:blockscout')

const TTL_TX = 30
const TTL_ADDR_TXS = 30
const TTL_ADDR_TOKEN_TRANSFERS = 300

async function proxy(req: Request, res: Response, ttlSeconds: number): Promise<void> {
  const cache = getRedis()
  // stripReservedParams runs at the public boundary so reserved params (e.g.
  // `apikey`) never reach upstream nor balloon the cache key namespace.
  const safeQuery = stripReservedParams(req.query as Record<string, string>)
  const cacheKey = buildCacheKey('blockscout', req.path, safeQuery)

  try {
    const cached = await cache?.get(cacheKey)
    if (cached) {
      res.json(JSON.parse(cached))
      return
    }
  } catch (err) {
    log.warn('redis read failed:', err instanceof Error ? err.message : err)
  }

  try {
    const data = await blockscoutGet({ path: req.path, query: safeQuery })
    try {
      await cache?.set(cacheKey, JSON.stringify(data), 'EX', ttlSeconds)
    } catch (err) {
      log.warn('redis write failed:', err instanceof Error ? err.message : err)
    }
    res.json(data)
  } catch (err) {
    log.warn('upstream error:', err instanceof Error ? err.message : err)
    res.status(502).json({ error: 'blockscout upstream unavailable' })
  }
}

router.get('/api/v2/transactions/:hash', async (req, res) => {
  const hash = req.params.hash ?? ''
  if (!HEX_BYTES32_RE.test(hash)) {
    return res.status(400).json({ error: 'invalid tx hash' })
  }
  await proxy(req, res, TTL_TX)
})

router.get('/api/v2/addresses/:address/transactions', async (req, res) => {
  const address = req.params.address ?? ''
  if (!HEX_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  await proxy(req, res, TTL_ADDR_TXS)
})

router.get('/api/v2/addresses/:address/token-transfers', async (req, res) => {
  const address = req.params.address ?? ''
  if (!HEX_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  await proxy(req, res, TTL_ADDR_TOKEN_TRANSFERS)
})

export default router
