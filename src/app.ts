import express from 'express'
import rateLimit from 'express-rate-limit'
import { hooksApiRouter } from './hooks-api/routes'
import { createLogger } from './lib/logger'
import blockscoutRouter from './routes/blockscout'
import eventsRouter from './routes/events'
import pricesRouter from './routes/prices'
import swapRouter from './routes/swap'
import wriRouter from './routes/wri'
import transactionsRouter from './transactions-indexer/routes'

const reqLog = createLogger('app:req')

export const app = express()

// Railway terminates TLS at one proxy hop. Telling Express to trust exactly one
// hop lets express-rate-limit see the real client IP without enabling IP
// spoofing via attacker-supplied X-Forwarded-For headers.
app.set('trust proxy', 1)

// 300 req/min/IP is the global ceiling across every endpoint. Sized for the
// observed worst case: a user firing ~10 swaps in 2-3 minutes triggers
// quote-refresh polling + receipt polling + feed/balance refresh, which
// realistically tops out around ~150-200 req/min for an active session.
// 300 leaves comfortable headroom while still blocking sustained bot abuse
// (5 req/s sustained for a minute is non-human). Per-endpoint tiering is on
// the roadmap once we have production traffic data; see ROADMAP.md.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate limit exceeded' },
  }),
)

app.use(express.json({ limit: '16kb' }))

app.use((req, _res, next) => {
  reqLog.info(`${req.method} ${req.path} ${JSON.stringify(req.query)}`)
  next()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tucopwallet-backend', version: '0.1.0' })
})

app.use(eventsRouter)
app.use(pricesRouter)
app.use(blockscoutRouter)
app.use(swapRouter)
app.use(wriRouter)
app.use(transactionsRouter)
app.use(hooksApiRouter)

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' })
})
