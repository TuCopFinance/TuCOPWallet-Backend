import path from 'path'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { hooksApiRouter } from './hooks-api/routes'
import { corsReadSkippingWrite, corsWrite, WRITE_PATHS } from './lib/cors'
import { createLogger } from './lib/logger'
import { httpRequestDurationSeconds } from './lib/metrics'
import { hashWalletAddress } from './lib/pii'
import { Sentry } from './lib/sentry'
import { neeruTimelockRouter } from './neeru-timelock/routes'
import blockscoutRouter from './routes/blockscout'
import earnNeeruCatalogueRouter from './routes/earn-neeru-catalogue'
import eventsRouter from './routes/events'
import healthRouter from './routes/health'
import metaContractsNeeruRouter from './routes/meta-contracts-neeru'
import positionsNotifyRouter from './routes/positions-notify'
import pricesRouter from './routes/prices'
import tokensRouter from './routes/tokens'
import tucoprampProxyRouter from './routes/tucopramp-proxy'
import txStatusRouter from './routes/tx-status'
import swapRouter from './routes/swap'
import wriRouter from './routes/wri'
import wriFeeBootstrapRouter from './routes/wri-fee-bootstrap'
import transactionsRouter from './transactions-indexer/routes'

const reqLog = createLogger('app:req')

export const app = express()

// Drop the default `X-Powered-By: Express` header (fingerprinting signal that
// tells attackers the framework in use). Nothing consumes it.
app.disable('x-powered-by')

// Baseline security headers via helmet. Defaults enable:
// - Strict-Transport-Security (max-age=15552000; includeSubDomains)
// - X-Content-Type-Options: nosniff
// - X-Frame-Options: SAMEORIGIN
// - Referrer-Policy: no-referrer
// - Cross-Origin-Opener-Policy / Cross-Origin-Resource-Policy
// CSP is intentionally left OFF: this backend serves JSON (not HTML), the
// only static assets are token logos + Neeru category images returned as
// PNG/SVG via express.static, and enabling CSP with the helmet defaults
// would forbid inline styles on 404 pages that Express renders. Add it
// selectively per-router if we ever serve HTML.
app.use(helmet({ contentSecurityPolicy: false }))

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

// TuCOPRamp proxy must own its own body-capture middleware BEFORE the
// app-wide express.json() runs. The proxy forwards the raw request
// body byte-for-byte to preserve the wallet's EIP-191 signature; any
// JSON parse-then-reserialise breaks the signature check upstream.
// Mounting the router here (out of order with the rest of the routers)
// gives express.raw() first crack at /api/tucopramp/* and lets
// express.json() no-op after the stream is already consumed.
app.use(tucoprampProxyRouter)

app.use(express.json({ limit: '16kb' }))

app.use((req, _res, next) => {
  reqLog.info(`${req.method} ${req.path} ${JSON.stringify(req.query)}`)
  // Per-request Sentry scope enrichment. Any captureException /
  // captureMessage fired downstream (including the auto-captured
  // unhandled errors via setupExpressErrorHandler at the bottom of this
  // file) inherits these tags + context for filtering/grouping.
  //
  // `http.route` uses `req.path` because Express only resolves the route
  // template AFTER the handler runs; setting the tag here avoids
  // touching every route. Cardinality is bounded by the static route
  // set (24 endpoints) except for the Blockscout proxy which embeds a
  // tx hash. The proxy path is normalized below to keep tag cardinality
  // low: `/api/v2/transactions/0xabc...` collapses to
  // `/api/v2/transactions/:hash`, likewise for the two other v2 param
  // paths. Wallet address, tx hash, and full unnormalised URL still
  // live in `request` context so per-user drill-down works from the
  // issue detail sidebar.
  const scope = Sentry.getCurrentScope()
  scope.setTags({
    'http.method': req.method,
    'http.route': normalizeRouteForTag(req.path),
  })
  const walletAddress = extractWalletAddress(req)
  scope.setContext('request', {
    path: req.path,
    query: req.query,
    // Pseudonymised pointer, not the raw address. Stable per user so
    // per-user drill-down in Sentry still works; unreversible without a
    // rainbow table of known addresses (PII_HASH_SALT makes any such
    // table single-environment).
    walletPseudonym: hashWalletAddress(walletAddress),
  })
  next()
})

// Route templates for endpoints that embed dynamic segments; used to
// collapse Sentry `http.route` cardinality so the tag store does not
// explode. Extend as new dynamic routes ship. Order matters (first hit
// wins) so more-specific patterns must come first when they share a
// prefix.
const DYNAMIC_ROUTE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/v2\/transactions\/0x[0-9a-fA-F]+$/, '/api/v2/transactions/:hash'],
  [/^\/api\/v2\/addresses\/0x[0-9a-fA-F]+\/transactions$/, '/api/v2/addresses/:address/transactions'],
  [/^\/api\/v2\/addresses\/0x[0-9a-fA-F]+\/token-transfers$/, '/api/v2/addresses/:address/token-transfers'],
  [/^\/tokens\/[A-Za-z0-9._-]+$/, '/tokens/:filename'],
  [/^\/assets\/neeru\/category-\d+\.png$/, '/assets/neeru/category-N.png'],
]

function normalizeRouteForTag(path: string): string {
  for (const [re, template] of DYNAMIC_ROUTE_PATTERNS) {
    if (re.test(path)) return template
  }
  return path
}

// Best-effort wallet address extraction from common request shapes.
// Sentry sidebar surfaces this via the `request` context so operators
// can drill into every issue by userAddress = 0x... across the whole
// backend. Prefers query > body > params in that order.
function extractWalletAddress(
  req: { query?: unknown; body?: unknown; params?: unknown },
): string | undefined {
  const HEX_ADDR = /^0x[a-fA-F0-9]{40}$/
  const candidates: unknown[] = []
  const q = req.query as Record<string, unknown> | undefined
  if (q) {
    candidates.push(q.address, q.userAddress, q.from, q.owner)
  }
  const b = req.body as Record<string, unknown> | undefined
  if (b) {
    candidates.push(b.address, b.userAddress, b.from)
  }
  const p = req.params as Record<string, unknown> | undefined
  if (p) {
    candidates.push(p.address)
  }
  for (const c of candidates) {
    if (typeof c === 'string' && HEX_ADDR.test(c)) return c.toLowerCase()
  }
  return undefined
}

// Retry-After on 503s. Wraps res.status so that when a handler down the
// chain sets a 503 (dependency down, feature gated off, upstream 503
// passthrough), the response carries `Retry-After: <RETRY_AFTER_SECONDS>`
// automatically. Clients that respect the header back off before hammering.
// Middleware runs BEFORE every route so all 503 emitters are covered; no
// per-route touch needed.
const RETRY_AFTER_SECONDS = 30
app.use((_req, res, next) => {
  const originalStatus = res.status.bind(res)
  res.status = (code: number) => {
    if (code === 503 && !res.getHeader('Retry-After')) {
      res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS))
    }
    return originalStatus(code)
  }
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

app.use(
  '/tokens',
  // Uses process.cwd() so the same path resolves in dev (tsx from repo root),
  // tests (jest from repo root), and prod (`node dist/server.js` from /app).
  // The /assets route above uses __dirname because the build copies
  // public/assets into dist/; we keep tokens/ served from the repo-rooted
  // public/ so PNGs are not duplicated across dist/.
  express.static(path.join(process.cwd(), 'public', 'tokens'), {
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
app.use(tokensRouter)
app.use(metaContractsNeeruRouter)
app.use(earnNeeruCatalogueRouter)
app.use(txStatusRouter)
app.use(positionsNotifyRouter)
app.use(blockscoutRouter)
app.use(swapRouter)
app.use(wriRouter)
app.use(wriFeeBootstrapRouter)
app.use(transactionsRouter)
app.use(hooksApiRouter)
app.use(neeruTimelockRouter)

// Sentry's error handler must be mounted AFTER all route handlers and BEFORE
// the catch-all 404 / final error middleware. No-op when SENTRY_DSN is unset.
Sentry.setupExpressErrorHandler(app)

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' })
})
