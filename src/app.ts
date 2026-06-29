import path from 'path'
import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { hooksApiRouter } from './hooks-api/routes'
import { createLogger } from './lib/logger'
import { httpRequestDurationSeconds } from './lib/metrics'
import blockscoutRouter from './routes/blockscout'
import eventsRouter from './routes/events'
import healthRouter from './routes/health'
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

// The primary caller is the TuCop wallet (React Native), which does not enforce
// CORS. Permissive CORS is set as defense-in-depth so future browser-based
// callers (webview/mini-app) work without code changes; credentials are off so
// no cookie/session surface is exposed.
app.use(cors({ origin: '*', credentials: false }))

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

// HTTP duration histogram observed per request. The `route` label uses the
// Express route template (e.g. `/api/v2/transactions/:hash`) rather than the
// raw URL so high-cardinality IDs don't blow up the Prometheus series count.
// Routes that did not match (404) get `route='unmatched'`.
app.use((req, res, next) => {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const elapsedNs = process.hrtime.bigint() - start
    const seconds = Number(elapsedNs) / 1e9
    const route = req.route?.path ?? (req.baseUrl ? `${req.baseUrl}*` : 'unmatched')
    httpRequestDurationSeconds
      .labels({
        method: req.method,
        route,
        status: String(res.statusCode),
      })
      .observe(seconds)
  })
  next()
})

app.use(
  '/assets',
  express.static(path.join(__dirname, 'public', 'assets'), {
    maxAge: '7d',
    immutable: true,
    fallthrough: true,
  }),
)

// Health + metrics router replaces the inline /health handler. It defines
// /health (liveness), /ready (deps probe), /health/relay, and /metrics.
app.use(healthRouter)
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
