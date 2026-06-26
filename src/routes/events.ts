import { Router, Request, Response } from 'express'
import { HEX_ADDRESS_RE, HEX_BYTES32_RE } from '../lib/hex'
import { fetchWithTimeout } from '../lib/http'
import { createLogger } from '../lib/logger'

const router = Router()
const log = createLogger('routes:events')

const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api'
const CELO_CHAIN_ID = 42220

// Lowercase 40-hex addresses only. The handler lower-cases incoming addresses
// before lookup, so do NOT add checksummed entries here.
export const ALLOWED_CONTRACTS = new Set<string>([
  '0x947c6db1569edc9fd37b017b791ca0f008ab4946', // ReFi Colombia Subsidies
])

router.get('/events', async (req: Request, res: Response) => {
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) {
    return res.status(503).json({ error: 'etherscan key not configured' })
  }

  const address = String(req.query.address ?? '').toLowerCase()
  const topic0 = req.query.topic0 ? String(req.query.topic0) : undefined
  const topic1 = req.query.topic1 ? String(req.query.topic1) : undefined
  const fromBlock = req.query.fromBlock ? String(req.query.fromBlock) : '0'
  const toBlock = req.query.toBlock ? String(req.query.toBlock) : 'latest'

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

  const params = new URLSearchParams({
    chainid: String(CELO_CHAIN_ID),
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
