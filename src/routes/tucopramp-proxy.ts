// Pass-through proxy for TuCOPRamp (2026-08-30 wallet request). The
// wallet signs the request path + body per EIP-191 and sends to
// `/api/tucopramp/v1/p2p/<...>`; backend strips only the /api/tucopramp
// prefix and forwards to `${TUCOPRAMP_UPSTREAM_URL}/v1/p2p/<...>` with
// the consumer key injected via the `X-TuCOPRamp-Key` header (kept
// server-side so the key never ships in the wallet binary).
//
// Path scope is `/v1/p2p/*` intentionally (wallet spec §2 + §7):
// TuCOPRamp admin surfaces are NOT proxied. A wallet mistake pointed
// at a non-p2p path 404s backend-side without spending consumer-key
// budget on a round trip that upstream would reject anyway.
//
// Preservation contract (MUST hold end-to-end):
//
// - Body is forwarded byte-for-byte. No JSON parse + re-serialise, no
//   multipart re-assembly. `express.raw()` is mounted on this route
//   BEFORE the app-wide `express.json()` middleware so `req.body` is a
//   Buffer of the exact bytes the wallet sent. Any deserialise +
//   reserialise cycle breaks the EIP-191 signature and the upstream
//   rejects with a generic error the user cannot debug.
// - Wallet-signed headers (X-Wallet-Address / X-Wallet-Timestamp /
//   X-Wallet-Signature / Idempotency-Key) pass through unchanged.
// - Content-Type + Content-Length pass through unchanged (matters for
//   multipart Content-Type with boundary=<...>).
// - Cookie / Authorization / X-Forwarded-* headers get stripped so a
//   browser session leaking into a proxied call cannot escalate to
//   upstream state.
// - Upstream status + body + Content-Type / Retry-After / Sunset
//   headers are echoed to the wallet without modification. The
//   request_id inside 4xx / 5xx error envelopes gets logged
//   server-side for cross-team triage.
//
// Failure modes:
//
// - Kill switch `TUCOPRAMP_PROXY_ENABLED=false` -> 503 { code:
//   "proxy_disabled" }. No upstream call made.
// - Missing upstream URL or consumer key for the active env -> 503
//   { code: "proxy_misconfigured" }. Operator error signal in Sentry.
// - Upstream timeout (30s) or network error -> 502 { code:
//   "upstream_unavailable" }. Wallet handles retry/backoff itself; the
//   proxy does not retry.
//
// Not implemented (intentional):
//
// - Rate limiting: TuCOPRamp enforces per-consumer (1000 req/min) and
//   per-wallet (60 req/min) upstream. 429 pass-through preserves
//   `Retry-After`. Duplicating limits proxy-side would add masking
//   without any real defense.
// - Response streaming: bodies buffer to memory before send. Max
//   observed multipart proof upload is a few MB (a photo of a bank
//   receipt); buffering is simpler + testable, and Railway's request
//   size limit already caps at 32MB. Switch to streaming if we hit
//   memory pressure.

import { Router, type Request, type Response as ExpressResponse } from 'express'
import express from 'express'
import { env } from '../lib/env'
import { fetchWithTimeout } from '../lib/http'
import { createLogger } from '../lib/logger'
import { Sentry } from '../lib/sentry'

const log = createLogger('routes:tucopramp-proxy')

const router = Router()

const PROXY_PATH_PREFIX = '/api/tucopramp'
// Only /v1/p2p/* is proxied; other paths under /api/tucopramp fall through
// to the app's 404 handler. Matches the wallet spec §2 + §7.
const PROXY_ROUTE_PATTERN = `${PROXY_PATH_PREFIX}/v1/p2p/*`
const UPSTREAM_TIMEOUT_MS = 30_000
// Cap raw body at 10 MB. Multipart proof uploads (bank receipt
// photos) empirically fit under 5 MB; 10 leaves headroom for future
// endpoints. Sits well below Railway's 32 MB request cap.
const MAX_BODY_BYTES = 10 * 1024 * 1024

// Wallet-signed headers pass through unchanged. Case is normalised to
// the canonical form the wallet spec lists so the upstream sees the
// exact string documented in the TuCOPRamp integration guide.
// Idempotency-Key is not signed but is idempotency-critical, so
// forward if present.
const WALLET_PASSTHROUGH_HEADERS: ReadonlyArray<string> = [
  'X-Wallet-Address',
  'X-Wallet-Timestamp',
  'X-Wallet-Signature',
  'Idempotency-Key',
  'Content-Type',
  'Content-Length',
]

// Upstream response headers we echo to the wallet. Explicit allowlist
// avoids accidentally leaking upstream infra headers (server names,
// CF-Ray, etc.) that the wallet does not need. HTTP cache-semantic
// headers (Cache-Control / ETag / Last-Modified / Vary) are forwarded
// so consumers can honour upstream cache hints and conditional GETs;
// TuCOPRamp `GET /v1/p2p/limits` and `/v1/p2p/banks` emit
// `Cache-Control: public, max-age=<n>` per guide v1.3.
const UPSTREAM_RESPONSE_HEADERS_TO_FORWARD: ReadonlyArray<string> = [
  'Content-Type',
  'Cache-Control',
  'ETag',
  'Last-Modified',
  'Vary',
  'Retry-After',
  'Sunset',
]

interface ProxyConfig {
  enabled: boolean
  upstream: string | null
  key: string | null
}

// Resolve at request time (not boot) so a Railway env flip of
// TUCOPRAMP_PROXY_ENABLED takes effect on the next request without a
// restart. Matches the pattern the WRI + integrator-fee routes use.
function resolveProxyConfig(): ProxyConfig {
  return {
    enabled: env.TUCOPRAMP_PROXY_ENABLED,
    upstream: env.TUCOPRAMP_UPSTREAM_URL ?? null,
    key: env.TUCOPRAMP_CONSUMER_KEY_PROD ?? null,
  }
}

// GET /health/tucopramp-proxy
//
// Read-only probe for coordination between backend + wallet + TuCOPRamp
// teams. Exposes only the enabled flag + upstream host (both harmless
// to disclose) so a wallet-side smoke can verify the proxy is up and
// pointing at the right upstream without asking for Railway access.
// Consumer key is NEVER exposed here; the shape is stable regardless
// of whether the key is set. Shape matches wallet spec §5.
router.get('/health/tucopramp-proxy', (_req: Request, res: ExpressResponse) => {
  const cfg = resolveProxyConfig()
  return res.json({
    enabled: cfg.enabled,
    upstream: cfg.upstream,
  })
})

// Body capture middleware. Mounted here (not app-wide) so only this
// prefix bypasses the app's `express.json({ limit: '16kb' })`. Using
// `type: '*/*'` catches multipart / octet-stream / json equally.
// Empty bodies (GET / HEAD / DELETE with no payload) resolve to an
// empty Buffer, not null.
router.use(
  PROXY_PATH_PREFIX,
  express.raw({ type: '*/*', limit: MAX_BODY_BYTES }),
)

// ALL /api/tucopramp/v1/p2p/<...>
//
// Handler across every HTTP method for the /v1/p2p namespace. Order
// matters: this must come AFTER the body-capture middleware above.
// Express 4 wildcard syntax: `/prefix/*` matches any nested path.
router.all(PROXY_ROUTE_PATTERN, async (req: Request, res: ExpressResponse) => {
  const cfg = resolveProxyConfig()

  if (!cfg.enabled) {
    return res.status(503).json({ code: 'proxy_disabled' })
  }
  if (!cfg.upstream || !cfg.key) {
    // Fire once per open-window so operators know the env is misconfigured.
    Sentry.captureMessage('tucopramp_proxy_misconfigured', {
      level: 'error',
      tags: {
        event: 'tucopramp_proxy_misconfigured',
      },
      extra: {
        hasUpstream: cfg.upstream !== null,
        hasKey: cfg.key !== null,
      },
    })
    return res.status(503).json({ code: 'proxy_misconfigured' })
  }

  // Strip the /api/tucopramp prefix from the original URL. Keep the
  // rest (path + querystring) BYTE-IDENTICAL because the wallet signs
  // the upstream path.
  const originalUrl = req.originalUrl
  const pathAfterPrefix = originalUrl.startsWith(PROXY_PATH_PREFIX)
    ? originalUrl.slice(PROXY_PATH_PREFIX.length)
    : originalUrl
  const trimmedUpstream = cfg.upstream.replace(/\/+$/, '')
  const upstreamUrl = `${trimmedUpstream}${pathAfterPrefix}`

  // Body: `express.raw()` yields Buffer for methods with a payload,
  // or an empty object for GET/HEAD (the middleware sees no
  // Content-Length header). Normalise to `undefined` for empty so
  // fetch does not send a bogus Content-Length: 0 with GET.
  const rawBody =
    Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined

  // Build forwarded headers. Case-preserving because upstream logs
  // and the integration guide reference these exact strings, and
  // some HTTP debug tools sort by case.
  const forwardHeaders = new Headers()
  for (const hdr of WALLET_PASSTHROUGH_HEADERS) {
    const value = req.header(hdr)
    if (value !== undefined) {
      forwardHeaders.set(hdr, value)
    }
  }
  forwardHeaders.set('X-TuCOPRamp-Key', cfg.key)

  let upstreamRes: Response
  try {
    upstreamRes = await fetchWithTimeout(
      upstreamUrl,
      {
        method: req.method,
        headers: forwardHeaders,
        body: rawBody,
      },
      UPSTREAM_TIMEOUT_MS,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`upstream request failed: ${msg}`)
    return res.status(502).json({ code: 'upstream_unavailable' })
  }

  // Echo status + allowed headers + body verbatim. Read the response
  // as an ArrayBuffer so binary responses (image proofs, etc.) round-
  // trip cleanly; UTF-8 JSON is a subset of that path and works
  // identically.
  const responseBuffer = Buffer.from(await upstreamRes.arrayBuffer())

  res.status(upstreamRes.status)
  for (const hdr of UPSTREAM_RESPONSE_HEADERS_TO_FORWARD) {
    const value = upstreamRes.headers.get(hdr)
    if (value !== null) {
      res.setHeader(hdr, value)
    }
  }

  // Per-request audit trail (wallet spec §6). One log.warn line per
  // request so the entry lands in prod (project logger prod level =
  // WARN). Volume is bounded by upstream's 60 req/min per-wallet cap.
  // Sensitive material NEVER logged: no headers (X-TuCOPRamp-Key,
  // X-Wallet-Signature), no request body, no response body content.
  //
  // On 4xx / 5xx, best-effort extract the upstream `request_id` from
  // the RFC 7807 envelope so a wallet ticket citing an error is
  // traceable to a specific upstream log line. Silent when the body
  // is not JSON (e.g. HTML error page from a proxy in front of
  // TuCOPRamp).
  let requestId: string | undefined
  if (upstreamRes.status >= 400) {
    try {
      const parsed = JSON.parse(responseBuffer.toString('utf-8')) as {
        request_id?: unknown
      }
      if (typeof parsed.request_id === 'string') {
        requestId = parsed.request_id
      }
    } catch {
      // Non-JSON response body; nothing to extract.
    }
  }
  log.warn(
    `proxy ${req.method} ${pathAfterPrefix} -> ${upstreamRes.status}` +
      (requestId ? ` request_id=${requestId}` : ''),
  )

  // `res.end(buffer)` instead of `res.send(buffer)`: `res.send()`
  // auto-generates a weak ETag over the response body when the
  // response has no ETag set. For a passthrough proxy that is a
  // correctness bug — a wallet doing a conditional GET with
  // `If-None-Match: <our-synth-etag>` would send an ETag the
  // upstream cannot recognise. When upstream DID send an ETag we
  // set it explicitly above and the wallet gets the real, semantic
  // ETag. Same reasoning applies to Content-Type auto-detection
  // (we already set it explicitly from upstream), so `res.end()`
  // is both safer and simpler for this route.
  return res.end(responseBuffer)
})

export default router
