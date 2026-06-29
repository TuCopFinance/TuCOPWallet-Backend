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

// Per-route query-param allowlists. Anything outside the set returns 400 at
// the boundary, so attacker-supplied params never reach upstream or get
// folded into the cache-key namespace. Mirrors what the wallet client
// actually sends today (Blockscout V2 pagination + filter keys). Adding a
// new param means a deliberate edit here, not silent passthrough.
const ALLOWED_TX_PARAMS = new Set<string>([])
const ALLOWED_ADDR_TXS_PARAMS = new Set<string>([
  'filter',
  'block_number',
  'index',
  'items_count',
])
const ALLOWED_ADDR_TOKEN_TRANSFERS_PARAMS = new Set<string>([
  'filter',
  'type',
  'token',
  'block_number',
  'index',
  'items_count',
])

function rejectUnknownParams(
  req: Request,
  res: Response,
  allowed: Set<string>,
): boolean {
  for (const key of Object.keys(req.query)) {
    if (!allowed.has(key)) {
      res.status(400).json({ error: 'unknown param' })
      return true
    }
  }
  return false
}

async function proxy(req: Request, res: Response, ttlSeconds: number): Promise<void> {
  const cache = getRedis()
  // stripReservedParams runs at the public boundary so reserved params (e.g.
  // `apikey`) never reach upstream nor balloon the cache key namespace.
  // Combined with the per-route allowlist above this is belt + suspenders.
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
  if (rejectUnknownParams(req, res, ALLOWED_TX_PARAMS)) return
  await proxy(req, res, TTL_TX)
})

router.get('/api/v2/addresses/:address/transactions', async (req, res) => {
  const address = req.params.address ?? ''
  if (!HEX_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  if (rejectUnknownParams(req, res, ALLOWED_ADDR_TXS_PARAMS)) return
  await proxy(req, res, TTL_ADDR_TXS)
})

router.get('/api/v2/addresses/:address/token-transfers', async (req, res) => {
  const address = req.params.address ?? ''
  if (!HEX_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  if (rejectUnknownParams(req, res, ALLOWED_ADDR_TOKEN_TRANSFERS_PARAMS)) return
  await proxy(req, res, TTL_ADDR_TOKEN_TRANSFERS)
})

export default router
