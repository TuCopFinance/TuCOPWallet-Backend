import { Router, Request, Response } from 'express'
import { HEX_ADDRESS_RE, HEX_BYTES32_RE } from '../lib/hex'
import { fetchWithTimeout } from '../lib/http'
import { createLogger } from '../lib/logger'
import { CELO_MAINNET_CHAIN_ID } from '../lib/networks'

const router = Router()
const log = createLogger('routes:events')

const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api'

// Decimal block number or the literal `latest`. Forwarded raw to Etherscan
// only after this validates; anything else is rejected at the boundary.
const BLOCK_RE = /^(?:\d{1,12}|latest)$/

// Lowercase 40-hex addresses only. The handler lower-cases incoming addresses
// before lookup, so do NOT add checksummed entries here.
export const ALLOWED_CONTRACTS = new Set<string>([
  '0x947c6db1569edc9fd37b017b791ca0f008ab4946', // ReFi Colombia Subsidies
])

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

router.get('/events', async (req: Request, res: Response) => {
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) {
    return res.status(503).json({ error: 'etherscan key not configured' })
  }

  // Express may surface query params as string | string[] | ParsedQs. Pick the
  // first string per key; arrays/objects become undefined and fail the regex
  // check below instead of getting coerced to "item1,item2".
  const addressRaw = firstString(req.query.address)
  const topic0 = firstString(req.query.topic0)
  const topic1 = firstString(req.query.topic1)
  const fromBlock = firstString(req.query.fromBlock) ?? '0'
  const toBlock = firstString(req.query.toBlock) ?? 'latest'

  const address = (addressRaw ?? '').toLowerCase()
  if (!HEX_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  if (!ALLOWED_CONTRACTS.has(address)) {
    return res.status(403).json({ error: 'contract not allowed' })
  }
  if (topic0 !== undefined && !HEX_BYTES32_RE.test(topic0)) {
    return res.status(400).json({ error: 'invalid topic0' })
  }
  if (topic1 !== undefined && !HEX_BYTES32_RE.test(topic1)) {
    return res.status(400).json({ error: 'invalid topic1' })
  }
  if (!BLOCK_RE.test(fromBlock) || !BLOCK_RE.test(toBlock)) {
    return res.status(400).json({ error: 'invalid block range' })
  }

  const params = new URLSearchParams({
    chainid: String(CELO_MAINNET_CHAIN_ID),
    module: 'logs',
    action: 'getLogs',
    address,
    fromBlock,
    toBlock,
    apikey: apiKey,
  })
  if (topic0) params.set('topic0', topic0)
  if (topic1) params.set('topic1', topic1)

  try {
    const upstream = await fetchWithTimeout(`${ETHERSCAN_API_URL}?${params.toString()}`)
    if (!upstream.ok) {
      log.warn(`etherscan http ${upstream.status} ${upstream.statusText}`)
      return res.status(502).json({ error: 'etherscan error' })
    }
    const data = (await upstream.json()) as { status: string; message: string; result: unknown }

    if (data.status !== '1' && data.message !== 'No records found') {
      // The Etherscan message can echo back the request including the apikey.
      // Log it server-side, never return it to the client.
      log.warn('etherscan error:', data.message)
      return res.status(502).json({ error: 'etherscan error' })
    }

    res.json({ events: Array.isArray(data.result) ? data.result : [] })
  } catch (error) {
    log.error('etherscan unreachable:', error instanceof Error ? error.message : error)
    res.status(502).json({ error: 'etherscan unreachable' })
  }
})

export default router
