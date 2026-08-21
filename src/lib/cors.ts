import type { RequestHandler } from 'express'
import cors from 'cors'

// Paths that require an origin allowlist (the write surface). Each path is
// matched as a prefix via `app.use(path, corsWrite)`; the listed routes have
// no sibling sub-paths so prefix-match is effectively exact-match.
export const WRITE_PATHS: readonly string[] = [
  '/api/wri/delegate-relay',
  '/api/wri/fee-adapter-bootstrap',
  '/api/transactions/watch',
  '/hooks-api/triggerShortcut',
]

// Permissive CORS for read endpoints. The primary caller (TuCop mobile wallet)
// is React Native and does not enforce CORS at all; we keep `*` here so future
// browser callers (webview / mini-app) can hit reads without a code change.
// Credentials are off so no cookie/session surface is exposed.
export const corsRead = cors({ origin: '*', credentials: false })

// Default allowlist for write paths. Operators add custom origins via the
// CORS_WRITE_ALLOWED_ORIGINS env (comma-separated).
const DEFAULT_WRITE_ORIGINS = [
  'https://tucop.xyz',
  'https://www.tucop.xyz',
  // Local dev variants. Safe to include in production since attackers can't
  // forge a real localhost origin from a browser.
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
]

export function getWriteAllowedOrigins(): readonly string[] {
  // Read process.env directly (rather than via the zod-frozen env proxy) so
  // tests can flip the value at runtime. Zod validates the shape at boot.
  const fromEnv = (process.env.CORS_WRITE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Env REPLACES the default when present, so operators can lock down to a
  // single origin in production without inheriting the localhost entries.
  return fromEnv.length > 0 ? fromEnv : DEFAULT_WRITE_ORIGINS
}

// Strict CORS for write paths.
//
// Rolled by hand rather than via the `cors` lib because the lib's behavior
// on rejected origins (`callback(null, false)`) is to drop the Allow-Origin
// header but still call next(). When a permissive CORS middleware is mounted
// later in the chain (as `corsRead` is), it overrides with `*` and the
// rejection becomes ineffective.
//
// Behavior:
//   - No Origin header (RN / curl / server-to-server)     -> next() and END the
//     chain so the global corsRead doesn't re-apply.
//   - Origin in allowlist                                  -> echo Origin, end
//     preflight inline, fall through actual requests via next() with END marker.
//   - Origin not in allowlist                              -> preflight returns
//     204 with no Allow-Origin header; non-preflight returns 403 immediately
//     instead of running the handler (defence in depth: the current write
//     endpoints already carry independent auth, but relying on the browser
//     to block would be fragile if a future endpoint forgot to add its own).
//
// The END marker is `res.locals.corsWriteHandled = true`, which the chain
// check below uses to skip the corsRead middleware.
export const corsWrite: RequestHandler = (req, res, next) => {
  res.locals.corsWriteHandled = true
  const origin = req.headers.origin
  const isPreflight =
    req.method === 'OPTIONS' && !!req.headers['access-control-request-method']

  const originAllowed = origin ? getWriteAllowedOrigins().includes(origin) : true
  if (origin && originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }

  if (isPreflight) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      String(req.headers['access-control-request-headers'] ?? 'content-type'),
    )
    res.setHeader('Access-Control-Max-Age', '600')
    res.status(204).end()
    return
  }
  if (!originAllowed) {
    res.status(403).json({ error: 'origin not allowed' })
    return
  }
  return next()
}

// Use this in place of `app.use(corsRead)` so corsWrite-handled paths don't
// get the permissive header applied on top.
export const corsReadSkippingWrite: RequestHandler = (req, res, next) => {
  if (res.locals.corsWriteHandled) return next()
  return corsRead(req, res, next)
}
