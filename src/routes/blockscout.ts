import { Router, Request, Response } from 'express'
import { blockscoutGet } from '../lib/blockscout'
import { getRedis } from '../lib/redis'

const router = Router()

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

const TTL_TX = 30
const TTL_ADDR_TXS = 30
const TTL_ADDR_TOKEN_TRANSFERS = 300

async function proxy(req: Request, res: Response, ttlSeconds: number): Promise<void> {
  const cache = getRedis()
  const cacheKey = `blockscout:${req.originalUrl}`

  try {
    const cached = await cache?.get(cacheKey)
    if (cached) {
      res.json(JSON.parse(cached))
      return
    }
  } catch (err) {
    console.warn('redis read failed:', err instanceof Error ? err.message : err)
  }

  try {
    const data = await blockscoutGet(req.originalUrl)
    try {
      await cache?.set(cacheKey, JSON.stringify(data), 'EX', ttlSeconds)
    } catch (err) {
      console.warn('redis write failed:', err instanceof Error ? err.message : err)
    }
    res.json(data)
  } catch (err) {
    console.warn('blockscout error:', err instanceof Error ? err.message : err)
    res.status(502).json({ error: 'blockscout upstream unavailable' })
  }
}

router.get('/api/v2/transactions/:hash', async (req, res) => {
  const hash = req.params.hash ?? ''
  if (!TX_HASH_RE.test(hash)) {
    return res.status(400).json({ error: 'invalid tx hash' })
  }
  await proxy(req, res, TTL_TX)
})

router.get('/api/v2/addresses/:address/transactions', async (req, res) => {
  const address = req.params.address ?? ''
  if (!ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  await proxy(req, res, TTL_ADDR_TXS)
})

router.get('/api/v2/addresses/:address/token-transfers', async (req, res) => {
  const address = req.params.address ?? ''
  if (!ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  await proxy(req, res, TTL_ADDR_TOKEN_TRANSFERS)
})

export default router
