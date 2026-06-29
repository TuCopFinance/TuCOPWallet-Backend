import type { RequestHandler } from 'express'
import cors from 'cors'

// Paths that require an origin allowlist (the write surface). Each path is
// matched as a prefix via `app.use(path, corsWrite)`; the listed routes have
// no sibling sub-paths so prefix-match is effectively exact-match.
export const WRITE_PATHS: readonly string[] = [
  '/api/wri/delegate-relay',
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
//   - Origin not in allowlist                              -> no Allow-Origin
//     header set, end preflight 204, return next() for non-preflight (the
//     handler will run but the browser blocks the response).
//
// The END marker is `res.locals.corsWriteHandled = true`, which the chain
// check below uses to skip the corsRead middleware.
export const corsWrite: RequestHandler = (req, res, next) => {
  res.locals.corsWriteHandled = true
  const origin = req.headers.origin
  const isPreflight =
    req.method === 'OPTIONS' && !!req.headers['access-control-request-method']

  if (origin) {
    const allowed = getWriteAllowedOrigins()
    if (allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    // Disallowed origin: no Allow-Origin header set; browser will block.
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
  return next()
}

// Use this in place of `app.use(corsRead)` so corsWrite-handled paths don't
// get the permissive header applied on top.
export const corsReadSkippingWrite: RequestHandler = (req, res, next) => {
  if (res.locals.corsWriteHandled) return next()
  return corsRead(req, res, next)
}
