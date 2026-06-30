import path from 'path'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { hooksApiRouter } from './hooks-api/routes'
import { corsReadSkippingWrite, corsWrite, WRITE_PATHS } from './lib/cors'
import { createLogger } from './lib/logger'
import { httpRequestDurationSeconds } from './lib/metrics'
import { Sentry } from './lib/sentry'
import blockscoutRouter from './routes/blockscout'
import eventsRouter from './routes/events'
import healthRouter from './routes/health'
import pricesRouter from './routes/prices'
import swapRouter from './routes/swap'
import wriRouter from './routes/wri'
import wriFeeBootstrapRouter from './routes/wri-fee-bootstrap'
import transactionsRouter from './transactions-indexer/routes'

const reqLog = createLogger('app:req')

export const app = express()

// Railway terminates TLS at one proxy hop. Telling Express to trust exactly one
// hop lets express-rate-limit see the real client IP without enabling IP
// spoofing via attacker-supplied X-Forwarded-For headers.
app.set('trust proxy', 1)

// CORS is split by surface:
//
// - Write paths (POST endpoints that touch state or sign txs) get a strict
//   origin allowlist via `corsWrite` so a malicious browser site visited by
//   a wallet user cannot cross-origin POST against /api/wri/delegate-relay,
//   /api/transactions/watch, or /hooks-api/triggerShortcut. Mounted FIRST so
//   the preflight matches this handler rather than the permissive one below.
// - Reads + everything else use `corsRead` (permissive `*`). The primary
//   caller (React Native) does not enforce CORS at all; permissive reads are
//   defense-in-depth for future browser callers (webview / mini-app).
//
// Requests with no Origin header (mobile, curl, server-to-server) always pass
// the write check; the only callers blocked are browsers on non-allowlisted
// origins.
for (const writePath of WRITE_PATHS) {
  app.use(writePath, corsWrite)
}
app.use(corsReadSkippingWrite)

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
app.use(wriFeeBootstrapRouter)
app.use(transactionsRouter)
app.use(hooksApiRouter)

// Sentry's error handler must be mounted AFTER all route handlers and BEFORE
// the catch-all 404 / final error middleware. No-op when SENTRY_DSN is unset.
Sentry.setupExpressErrorHandler(app)

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' })
})
