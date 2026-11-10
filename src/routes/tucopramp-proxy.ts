// Pass-through proxy for TuCOPRamp (2026-08-30 wallet request). The
// wallet signs the request path + body per EIP-191 and sends to
// `/api/tucopramp/p2p/<...>`; backend strips only the /api/tucopramp
// prefix and forwards to `${TUCOPRAMP_UPSTREAM_URL}/p2p/<...>` with
// the consumer key injected via the `X-TuCOPRamp-Key` header (kept
// server-side so the key never ships in the wallet binary).
//
// Upstream paths carry NO version segment. TuCOPRamp served `/v1/<path>`
// as a deprecated alias for a while and then deleted it, so a forwarded
// `/v1/...` now 404s there. There is no compatibility window on this side
// either, deliberately: the wallet signs the path and upstream verifies
// the signature over the path it received, so accepting `/v1` and
// rewriting it would turn an honest 404 into a `signature_invalid` that
// nobody can debug from a support ticket. Anything under
// `/api/tucopramp/v1` gets an explicit 410 instead, which names the
// problem (old client) rather than looking like a missing route.
//
// Path scope is the P2P ramp plus the platform API the Bridge-backed ramp
// uses (wallet spec §2 + §7): TuCOPRamp admin surfaces are NOT proxied.
// A wallet mistake pointed at an unlisted path 404s backend-side without
// spending consumer-key budget on a round trip that upstream would reject
// anyway.
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

import {
  Router,
  type Request,
  type Response as ExpressResponse,
} from "express";
import express from "express";
import { publicClientIp } from "../lib/clientIp";
import { env } from "../lib/env";
import { fetchWithTimeout } from "../lib/http";
import { createLogger } from "../lib/logger";
import { Sentry } from "../lib/sentry";

const log = createLogger("routes:tucopramp-proxy");

const router = Router();

const PROXY_PATH_PREFIX = "/api/tucopramp";
// /p2p/* is the direct (P2P) ramp. The rest are TuCOPRamp's platform API
// used by the Bridge-backed ramp: party sessions, parties, destinations,
// quotes, payments, withdrawals, deposits and the identity-document
// catalogue. Admin and operator surfaces are never proxied; anything else
// under /api/tucopramp falls through to the app's 404 handler.
const PROXY_UPSTREAM_PREFIXES: ReadonlyArray<string> = [
  "/p2p",
  "/sessions",
  "/parties",
  "/destinations",
  "/quotes",
  "/payments",
  "/withdrawals",
  "/deposits",
  // GET /document-types: the identity documents accepted per country, for
  // the parties / KYC track. Static, cacheable, and upstream serves it on
  // the consumer key alone, so it is deliberately NOT in the
  // party-session list below. The wallet must not hardcode this catalogue
  // (TuCOPRamp requires that, and it differs from the P2P document set,
  // which stays a fixed enum because those six values are the contract its
  // zod schema validates).
  "/document-types",
];
// Platform routes that act for a party. TuCOPRamp lets an integrator whose own
// Bridge customer it linked call these with the API key alone; this proxy
// injects the consumer key for anyone on the internet, so it never forwards
// them without the caller's own party session.
const PARTY_SESSION_REQUIRED_PREFIXES: ReadonlyArray<string> = [
  "/parties",
  "/destinations",
  "/quotes",
  "/payments",
  "/withdrawals",
  "/deposits",
];

// Routes never proxied even though they sit under an allowed prefix.
//
// GET /p2p/onramp/orders lists EVERY on-ramp order of the whole consumer,
// across all wallets, and takes no wallet filter (TuCOPRamp's handler calls
// listForConsumer and reads no query params). Each row carries
// wallet_address, status, gross_amount_cop and outgoing_tx_hash, so exposing
// it to a client is third-party data disclosure. It is a backend-to-backend
// read; the wallet lists a user's own orders through GET /p2p/orders, which
// is wallet-scoped upstream.
//
// Matched on method AND path: POST /p2p/onramp/orders creates an order and
// IS proxied.
const NEVER_PROXY: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/p2p/onramp/orders" },
];

// The on-ramp order creation path, where the destination wallet has to be the
// wallet that signed (see the check in the handler).
const ONRAMP_ORDERS_PATH = "/p2p/onramp/orders";

// Path used for gate comparisons only. NEVER for forwarding: the wallet signs
// the path it sent, so the bytes that go upstream stay exactly as received.
//
// Collapsing duplicate slashes and dropping the trailing slash closes a real
// bypass: Express routes with `strict routing` off, so upstream answers
// `/p2p/onramp/orders/` exactly as `/p2p/onramp/orders`, and a raw comparison
// would wave the trailing-slash form straight past the gates below.
function normalizeForMatch(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}
const PROXY_ROUTE_PATTERNS = PROXY_UPSTREAM_PREFIXES.flatMap((prefix) => [
  `${PROXY_PATH_PREFIX}${prefix}`,
  `${PROXY_PATH_PREFIX}${prefix}/*`,
]);
const UPSTREAM_TIMEOUT_MS = 30_000;
// Cap raw body at 10 MB. Multipart proof uploads (bank receipt
// photos) empirically fit under 5 MB; 10 leaves headroom for future
// endpoints. Sits well below Railway's 32 MB request cap.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Wallet-signed headers pass through unchanged. Case is normalised to
// the canonical form the wallet spec lists so the upstream sees the
// exact string documented in the TuCOPRamp integration guide.
// Idempotency-Key is not signed but is idempotency-critical, so
// forward if present.
const WALLET_PASSTHROUGH_HEADERS: ReadonlyArray<string> = [
  "X-Wallet-Address",
  "X-Wallet-Timestamp",
  "X-Wallet-Signature",
  "Idempotency-Key",
  // Platform routes act for a party through a session the wallet opened with
  // a signature; the token is the wallet's, not the backend's.
  "X-TuCOPRamp-Party-Session",
  "Content-Type",
  "Content-Length",
];
// Deliberately NOT in the list above:
//
// - TuCOPRamp-Version. The upstream server reads no version header at all
//   (its own OpenAPI marks the response header "Deprecated. The single API
//   version; nothing needs to read it."), and the wallet never sent one. The
//   comment that used to sit here claimed upstream falls back to "the
//   consumer's pinned version" without it, which was never true.
// - X-TuCOPRamp-Client-IP. We DO forward it, but as a value this backend
//   computes from the connection (see below), never as a header read off the
//   request. Reading it from the caller is the whole attack: upstream trusts
//   this relay's word on the header, so a client that could set it would get
//   to scatter its traffic across addresses it made up. Building the
//   forwarded set from an explicit allowlist means a client-supplied copy is
//   dropped here, and the explicit `set()` later overrides it regardless.

// Upstream response headers we echo to the wallet. Explicit allowlist
// avoids accidentally leaking upstream infra headers (server names,
// CF-Ray, etc.) that the wallet does not need. HTTP cache-semantic
// headers (Cache-Control / ETag / Last-Modified / Vary) are forwarded
// so consumers can honour upstream cache hints and conditional GETs;
// TuCOPRamp `GET /p2p/limits` and `/p2p/banks` emit
// `Cache-Control: public, max-age=<n>` (upstream server/openapi.yaml).
const UPSTREAM_RESPONSE_HEADERS_TO_FORWARD: ReadonlyArray<string> = [
  "Content-Type",
  "Cache-Control",
  "ETag",
  "Last-Modified",
  "Vary",
  "Retry-After",
  "Sunset",
];

interface ProxyConfig {
  enabled: boolean;
  upstream: string | null;
  key: string | null;
}

// Resolve at request time via the shared `env` proxy. Note that `env`
// is lazy but cache-once: `parseEnv()` populates `cachedEnv` on the
// first access at boot (src/lib/env.ts). Subsequent per-request reads
// return the cached value. So a Railway env-var change does NOT
// hot-reload in the running process; instead Railway auto-triggers a
// rolling redeploy (~2-5 min, zero downtime) and the new container
// comes up with the new value. Calling `resolveProxyConfig()`
// per-request is still worth doing (it groups the 3 vars into one
// snapshot per handler invocation) but does not mean "env-flip
// latest without restart", which was the earlier incorrect wording.
function resolveProxyConfig(): ProxyConfig {
  return {
    enabled: env.TUCOPRAMP_PROXY_ENABLED,
    upstream: env.TUCOPRAMP_UPSTREAM_URL ?? null,
    key: env.TUCOPRAMP_CONSUMER_KEY_PROD ?? null,
  };
}

// GET /health/tucopramp-proxy
//
// Read-only probe for coordination between backend + wallet + TuCOPRamp
// teams. Exposes only the enabled flag + upstream host (both harmless
// to disclose) so a wallet-side smoke can verify the proxy is up and
// pointing at the right upstream without asking for Railway access.
// Consumer key is NEVER exposed here; the shape is stable regardless
// of whether the key is set. Shape matches wallet spec §5.
router.get("/health/tucopramp-proxy", (_req: Request, res: ExpressResponse) => {
  const cfg = resolveProxyConfig();
  return res.json({
    enabled: cfg.enabled,
    upstream: cfg.upstream,
  });
});

// Body capture middleware. Mounted here (not app-wide) so only this
// prefix bypasses the app's `express.json({ limit: '16kb' })`. Using
// `type: '*/*'` catches multipart / octet-stream / json equally.
// Empty bodies (GET / HEAD / DELETE with no payload) resolve to an
// empty Buffer, not null.
router.use(
  PROXY_PATH_PREFIX,
  express.raw({ type: "*/*", limit: MAX_BODY_BYTES }),
);

// ALL /api/tucopramp/v1/<...>
//
// Upstream retired the `/v1` alias, so forwarding one of these would just
// buy a 404 from TuCOPRamp on our consumer-key budget. Answering 410 here
// instead names the actual problem for whoever reads the log or the support
// ticket: the caller is a build from before the paths lost their version.
//
// Registered BEFORE the proxy handler, and intentionally outside the kill
// switch and the config check: the answer does not depend on either, and an
// old client deserves the same clear signal whether or not the ramp is up.
//
// Only the exact `/v1` segment matches, so `/v10/...` still falls through to
// the app 404 like any other unlisted path.
router.all(
  [`${PROXY_PATH_PREFIX}/v1`, `${PROXY_PATH_PREFIX}/v1/*`],
  (req: Request, res: ExpressResponse) => {
    log.warn(`versioned path rejected: ${req.method} ${req.originalUrl}`);
    return res.status(410).json({ code: "versioned_path_removed" });
  },
);

// ALL /api/tucopramp/<allowed prefix>/<...>
//
// Handler across every HTTP method for the allowed namespaces. Order
// matters: this must come AFTER the body-capture middleware above.
// Express 4 wildcard syntax: `/prefix/*` matches any nested path.
router.all(PROXY_ROUTE_PATTERNS, async (req: Request, res: ExpressResponse) => {
  const cfg = resolveProxyConfig();

  if (!cfg.enabled) {
    return res.status(503).json({ code: "proxy_disabled" });
  }
  if (!cfg.upstream || !cfg.key) {
    // Fire once per open-window so operators know the env is misconfigured.
    Sentry.captureMessage("tucopramp_proxy_misconfigured", {
      level: "error",
      tags: {
        event: "tucopramp_proxy_misconfigured",
      },
      extra: {
        hasUpstream: cfg.upstream !== null,
        hasKey: cfg.key !== null,
      },
    });
    return res.status(503).json({ code: "proxy_misconfigured" });
  }

  // Strip the /api/tucopramp prefix from the original URL. Keep the
  // rest (path + querystring) BYTE-IDENTICAL because the wallet signs
  // the upstream path.
  const originalUrl = req.originalUrl;
  const pathAfterPrefix = originalUrl.startsWith(PROXY_PATH_PREFIX)
    ? originalUrl.slice(PROXY_PATH_PREFIX.length)
    : originalUrl;
  const upstreamPath = pathAfterPrefix.split("?")[0] ?? "";
  // Every gate below compares the normalized form; only the raw
  // `pathAfterPrefix` is ever forwarded.
  const matchPath = normalizeForMatch(upstreamPath);
  const method = req.method.toUpperCase();

  // Blocked outright, no upstream call: nothing to spend the consumer key on
  // and nothing for the caller to learn from the shape of the answer, so this
  // is the app's own 404 rather than a 403 that would confirm the route is
  // real.
  if (NEVER_PROXY.some((r) => r.method === method && r.path === matchPath)) {
    log.warn(`blocked consumer-scoped route: ${method} ${matchPath}`);
    return res.status(404).json({ code: "not_found" });
  }

  const needsPartySession = PARTY_SESSION_REQUIRED_PREFIXES.some(
    (prefix) => matchPath === prefix || matchPath.startsWith(`${prefix}/`),
  );
  if (needsPartySession && !req.header("X-TuCOPRamp-Party-Session")?.trim()) {
    return res.status(401).json({
      code: "party_session_required",
      detail: "X-TuCOPRamp-Party-Session is required.",
    });
  }
  const trimmedUpstream = cfg.upstream.replace(/\/+$/, "");
  const upstreamUrl = `${trimmedUpstream}${pathAfterPrefix}`;

  // Body: `express.raw()` yields Buffer for methods with a payload,
  // or an empty object for GET/HEAD (the middleware sees no
  // Content-Length header). Normalise to `undefined` for empty so
  // fetch does not send a bogus Content-Length: 0 with GET.
  const rawBody =
    Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  // On-ramp destination must be the wallet that signed.
  //
  // TuCOPRamp verifies the signature over method + path + body hash and so
  // knows WHICH wallet asked, but it deliberately does not compare that
  // wallet with `wallet_address` in the body: on-ramping COPm to someone
  // else's wallet is a case it supports on purpose, and its own source says
  // so. Our product never offers it, so for us a request whose destination is
  // a different wallet is either a modified client or someone spending our
  // consumer-key budget to move COPm somewhere we did not intend.
  //
  // The header is only as trustworthy as upstream's signature check, which is
  // what makes this a complement rather than the whole defense: upstream
  // proves the signer owns the address in X-Wallet-Address, and this proves
  // the signer is also the destination. Dropping either half reopens the gap.
  //
  // Parse a COPY to validate. `rawBody` is forwarded untouched: re-serialising
  // it would change the bytes and break the EIP-191 signature, which is what
  // tests T2 and T3 exist to catch.
  //
  // If we ever do want "top up a relative's wallet", this block comes out as a
  // decision, not by accident.
  if (method === "POST" && matchPath === ONRAMP_ORDERS_PATH) {
    const signer = req.header("X-Wallet-Address")?.trim().toLowerCase();
    let destination: string | undefined;
    try {
      const parsed: unknown = JSON.parse(rawBody?.toString("utf8") ?? "{}");
      const value =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { wallet_address?: unknown }).wallet_address
          : undefined;
      // A non-string wallet_address is upstream's 400 to give, not a reason
      // to throw in here.
      destination =
        typeof value === "string" ? value.trim().toLowerCase() : undefined;
    } catch {
      return res.status(400).json({ code: "invalid_json" });
    }
    if (!signer || !destination || signer !== destination) {
      log.warn(`onramp destination mismatch on ${matchPath}`);
      return res.status(403).json({
        code: "onramp_destination_mismatch",
        detail: "wallet_address must be the signing wallet.",
      });
    }
  }

  // Build forwarded headers. Case-preserving because upstream logs
  // and the integration guide reference these exact strings, and
  // some HTTP debug tools sort by case.
  const forwardHeaders = new Headers();
  for (const hdr of WALLET_PASSTHROUGH_HEADERS) {
    const value = req.header(hdr);
    if (value !== undefined) {
      forwardHeaders.set(hdr, value);
    }
  }
  forwardHeaders.set("X-TuCOPRamp-Key", cfg.key);

  // End-user IP, on EVERY proxied call (TuCOPRamp asked for all of them, not
  // just the session routes).
  //
  // TuCOPRamp marked this backend as a trusted relay, so its per-IP limits
  // key on this header instead of the Railway egress address everything
  // arrives from. Without it all of our users share a single bucket: at five
  // users nobody notices, at five hundred one busy user burns the quota and
  // every other user gets 429 from a ramp that looks down. Upstream ignores
  // the header from anyone who is not a trusted relay, so it is inert if the
  // relay designation is ever withdrawn.
  //
  // `req.ip` already resolves X-Forwarded-For under the app's
  // `trust proxy = 1` (src/app.ts), which is the one hop Railway terminates;
  // a caller-supplied X-Forwarded-For does not become `req.ip` and is never
  // forwarded. A private, malformed or absent address sends no header at all,
  // because a wrong address collides distinct users into one bucket AND tells
  // upstream something false, which is worse than saying nothing.
  const clientIp = publicClientIp(req.ip);
  if (clientIp) {
    forwardHeaders.set("X-TuCOPRamp-Client-IP", clientIp);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetchWithTimeout(
      upstreamUrl,
      {
        method: req.method,
        headers: forwardHeaders,
        body: rawBody,
      },
      UPSTREAM_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`upstream request failed: ${msg}`);
    return res.status(502).json({ code: "upstream_unavailable" });
  }

  // Echo status + allowed headers + body verbatim. Read the response
  // as an ArrayBuffer so binary responses (image proofs, etc.) round-
  // trip cleanly; UTF-8 JSON is a subset of that path and works
  // identically.
  const responseBuffer = Buffer.from(await upstreamRes.arrayBuffer());

  res.status(upstreamRes.status);
  for (const hdr of UPSTREAM_RESPONSE_HEADERS_TO_FORWARD) {
    const value = upstreamRes.headers.get(hdr);
    if (value !== null) {
      res.setHeader(hdr, value);
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
  let requestId: string | undefined;
  if (upstreamRes.status >= 400) {
    try {
      const parsed = JSON.parse(responseBuffer.toString("utf-8")) as {
        request_id?: unknown;
      };
      if (typeof parsed.request_id === "string") {
        requestId = parsed.request_id;
      }
    } catch {
      // Non-JSON response body; nothing to extract.
    }
  }
  log.warn(
    `proxy ${req.method} ${pathAfterPrefix} -> ${upstreamRes.status}` +
      (requestId ? ` request_id=${requestId}` : ""),
  );

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
  return res.end(responseBuffer);
});

export default router;
