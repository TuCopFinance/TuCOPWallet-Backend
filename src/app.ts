import express, { Request, Response } from 'express'
import pricesRouter from './routes/prices'
import blockscoutRouter from './routes/blockscout'

const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api'
const CELO_CHAIN_ID = 42220

const ALLOWED_CONTRACTS = new Set<string>([
  '0x947c6db1569edc9fd37b017b791ca0f008ab4946', // ReFi Colombia Subsidies
])

const isHex = (s: string, len?: number): boolean => {
  if (!s.startsWith('0x')) return false
  const body = s.slice(2)
  if (len !== undefined && body.length !== len) return false
  return /^[a-fA-F0-9]+$/.test(body)
}

export const app = express()

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path} ${JSON.stringify(req.query)}`,
  )
  next()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tucopwallet-backend', version: '0.1.0' })
})

app.get('/events', async (req: Request, res: Response) => {
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) {
    return res.status(503).json({ error: 'etherscan key not configured' })
  }

  const address = String(req.query.address ?? '').toLowerCase()
  const topic0 = req.query.topic0 ? String(req.query.topic0) : undefined
  const topic1 = req.query.topic1 ? String(req.query.topic1) : undefined
  const fromBlock = req.query.fromBlock ? String(req.query.fromBlock) : '0'
  const toBlock = req.query.toBlock ? String(req.query.toBlock) : 'latest'

  if (!isHex(address, 40)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  if (!ALLOWED_CONTRACTS.has(address)) {
    return res.status(403).json({ error: 'contract not allowed' })
  }
  if (topic0 !== undefined && !isHex(topic0, 64)) {
    return res.status(400).json({ error: 'invalid topic0' })
  }
  if (topic1 !== undefined && !isHex(topic1, 64)) {
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
    const upstream = await fetch(`${ETHERSCAN_API_URL}?${params.toString()}`)
    const data = (await upstream.json()) as { status: string; message: string; result: unknown }

    if (data.status !== '1' && data.message !== 'No records found') {
      console.warn('Etherscan error:', data.message)
      return res.status(502).json({ error: 'etherscan error', detail: data.message })
    }

    res.json({ events: Array.isArray(data.result) ? data.result : [] })
  } catch (error) {
    console.error('Etherscan unreachable:', error instanceof Error ? error.message : error)
    res.status(502).json({ error: 'etherscan unreachable' })
  }
})

app.use(pricesRouter)
app.use(blockscoutRouter)

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' })
})
