import { createHash } from 'crypto'
import request from 'supertest'
import { _resetParsedEnvForTests } from '../lib/env'

const REAL_FETCH = global.fetch

// Capture every outbound upstream call the proxy makes so per-test
// assertions can inspect method / url / headers / body without a
// real network hop.
interface CapturedCall {
  url: string
  init: {
    method?: string
    headers?: Headers
    body?: Buffer | undefined
  }
}
let captured: CapturedCall[] = []
let nextUpstreamResponse: {
  status: number
  body: Buffer
  headers: Record<string, string>
} = { status: 200, body: Buffer.from('{}'), headers: { 'Content-Type': 'application/json' } }

async function bodyToBuffer(body: unknown): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (typeof body === 'string') return Buffer.from(body)
  // Node fetch may hand off a ReadableStream when the request body is
  // wrapped by Headers/Blob. In this test suite we always send Buffers
  // directly so this branch is defensive; drain and concat.
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  }
  return undefined
}

function installMockFetch(): void {
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { toString(): string }).toString()
    captured.push({
      url,
      init: {
        method: init?.method,
        headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers),
        body: await bodyToBuffer(init?.body),
      },
    })
    return new Response(nextUpstreamResponse.body, {
      status: nextUpstreamResponse.status,
      headers: nextUpstreamResponse.headers,
    })
  }) as typeof global.fetch
}

// Env is validated + frozen at first `env` access. Reset the parsed
// cache before each test so per-test env flips take effect.
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  _resetParsedEnvForTests()
}

beforeEach(() => {
  captured = []
  nextUpstreamResponse = {
    status: 200,
    body: Buffer.from('{}'),
    headers: { 'Content-Type': 'application/json' },
  }
  installMockFetch()
  setEnv({
    TUCOPRAMP_PROXY_ENABLED: 'true',
    TUCOPRAMP_UPSTREAM_URL: 'https://api.ramp.tucop.xyz',
    TUCOPRAMP_CONSUMER_KEY_PROD: 'tcr_prod_test_key_cafebabe',
  })
})

afterEach(() => {
  global.fetch = REAL_FETCH
  setEnv({
    TUCOPRAMP_PROXY_ENABLED: undefined,
    TUCOPRAMP_UPSTREAM_URL: undefined,
    TUCOPRAMP_CONSUMER_KEY_PROD: undefined,
  })
})

// Import AFTER installMockFetch runs in beforeEach: app.ts is loaded
// once per suite, but its route handlers close over the current
// global.fetch reference (Node fetch does not bind at module load).
import { app } from '../app'

describe('GET /health/tucopramp-proxy', () => {
  it('exposes enabled + upstream but never the consumer key', async () => {
    const res = await request(app).get('/health/tucopramp-proxy')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      enabled: true,
      upstream: 'https://api.ramp.tucop.xyz',
    })
    // Whitelist assertion: no key field, no key value, at any depth.
    const asString = JSON.stringify(res.body)
    expect(asString).not.toContain('tcr_')
    expect(asString).not.toContain('key')
  })

  it('shape stays the same when the kill switch is OFF (enabled:false, upstream still visible)', async () => {
    setEnv({ TUCOPRAMP_PROXY_ENABLED: 'false' })
    const res = await request(app).get('/health/tucopramp-proxy')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      enabled: false,
      upstream: 'https://api.ramp.tucop.xyz',
    })
  })
})

describe('ALL /api/tucopramp/v1/p2p/*', () => {
  it('T1: GET passes wallet-signed headers unchanged + injects X-TuCOPRamp-Key', async () => {
    // Wallet spec §3: X-Wallet-Address, X-Wallet-Timestamp,
    // X-Wallet-Signature, Idempotency-Key MUST reach upstream verbatim.
    // Backend injects X-TuCOPRamp-Key with the consumer key.
    const res = await request(app)
      .get('/api/tucopramp/v1/p2p/banks?limit=10')
      .set('X-Wallet-Address', '0x81dCf9160237D0EF0d4db27CFb2EA9743547f882')
      .set('X-Wallet-Timestamp', '1735689600')
      .set('X-Wallet-Signature', '0xdeadbeef')
      .set('Idempotency-Key', 'idem-abc-123')
    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    const call = captured[0]!
    expect(call.url).toBe('https://api.ramp.tucop.xyz/v1/p2p/banks?limit=10')
    expect(call.init.method).toBe('GET')
    const h = call.init.headers!
    expect(h.get('X-Wallet-Address')).toBe('0x81dCf9160237D0EF0d4db27CFb2EA9743547f882')
    expect(h.get('X-Wallet-Timestamp')).toBe('1735689600')
    expect(h.get('X-Wallet-Signature')).toBe('0xdeadbeef')
    expect(h.get('Idempotency-Key')).toBe('idem-abc-123')
    expect(h.get('X-TuCOPRamp-Key')).toBe('tcr_prod_test_key_cafebabe')
  })

  it('T2: POST with JSON body forwards bytes verbatim (SHA256 identical)', async () => {
    // Guard against a middleware that JSON.parse + re-stringify the
    // request body, which would reorder keys / re-quote strings /
    // rewrite whitespace and break the EIP-191 signature check
    // upstream. SHA256 of the wallet-sent bytes must match SHA256 of
    // the bytes the proxy forwarded.
    // Intentionally non-canonical JSON (space after colon, trailing
    // newline) to prove the proxy does NOT round-trip through
    // JSON.parse. Send as a string with an explicit octet-stream
    // Content-Type so supertest / superagent do not JSON-serialise
    // the payload behind our back; the assertion cares about what
    // the proxy FORWARDS, not the specific Content-Type on the wire
    // for the test scaffolding (a real wallet posts with
    // application/json + the wallet's exact bytes).
    const payloadString = '{"orderId":"ord_123", "amountCop":50000 ,"walletAddress":"0x81dc"}\n'
    const payload = Buffer.from(payloadString)
    const expectedHash = createHash('sha256').update(payload).digest('hex')

    const res = await request(app)
      .post('/api/tucopramp/v1/p2p/orders')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Wallet-Address', '0x81dc')
      .set('X-Wallet-Signature', '0xsig')
      .send(payload)
    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    const forwardedBody = captured[0]!.init.body
    expect(forwardedBody).toBeDefined()
    const forwardedHash = createHash('sha256').update(forwardedBody!).digest('hex')
    expect(forwardedHash).toBe(expectedHash)
    expect(forwardedBody!.equals(payload)).toBe(true)
  })

  it('T3: multipart forwards Content-Type with boundary intact + body bytes verbatim', async () => {
    // Multipart proof upload (POST /orders/{id}/proof). Content-Type
    // carries the boundary marker the wallet chose; if the proxy
    // reassembles the multipart body, the boundary will not match
    // what the header advertises and the upstream parser fails.
    const boundary = '----WalletBoundary_9a8b7c6d5e4f3a2b'
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="proof"; filename="receipt.jpg"\r\n'),
      Buffer.from('Content-Type: image/jpeg\r\n\r\n'),
      // Fake JPEG magic bytes + tiny payload
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const expectedHash = createHash('sha256').update(multipartBody).digest('hex')

    const res = await request(app)
      .post('/api/tucopramp/v1/p2p/orders/ord_123/proof')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .set('X-Wallet-Address', '0x81dc')
      .set('X-Wallet-Signature', '0xsig')
      .send(multipartBody)
    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    const call = captured[0]!
    // Content-Type WITH boundary passed verbatim.
    expect(call.init.headers!.get('Content-Type')).toBe(
      `multipart/form-data; boundary=${boundary}`,
    )
    // Body bytes byte-identical to what the wallet sent.
    const forwardedBody = call.init.body
    expect(forwardedBody).toBeDefined()
    expect(forwardedBody!.equals(multipartBody)).toBe(true)
    expect(createHash('sha256').update(forwardedBody!).digest('hex')).toBe(expectedHash)
  })

  it('T4: kill switch OFF returns 503 { code: "proxy_disabled" } without touching upstream', async () => {
    setEnv({ TUCOPRAMP_PROXY_ENABLED: 'false' })
    const res = await request(app)
      .post('/api/tucopramp/v1/p2p/orders')
      .set('X-Wallet-Address', '0x81dc')
      .send({ any: 'payload' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ code: 'proxy_disabled' })
    // Critical: zero upstream calls when disabled.
    expect(captured).toHaveLength(0)
  })

  it('T5: upstream 4xx / 5xx forwards status + body without modifying the error envelope', async () => {
    // Simulate upstream returning a canonical error envelope with a
    // request_id (backend logs but does NOT rewrite / strip it).
    const errorEnvelope = {
      code: 'insufficient_liquidity',
      message: 'no counterparty at this size in the current window',
      request_id: 'req_upstream_abc123',
    }
    nextUpstreamResponse = {
      status: 422,
      body: Buffer.from(JSON.stringify(errorEnvelope)),
      headers: { 'Content-Type': 'application/json', 'Retry-After': '17' },
    }
    const res = await request(app)
      .post('/api/tucopramp/v1/p2p/orders')
      .set('Content-Type', 'application/json')
      .set('X-Wallet-Address', '0x81dc')
      .send({ orderId: 'ord_new' })
    expect(res.status).toBe(422)
    // Body byte-identical.
    expect(res.body).toEqual(errorEnvelope)
    // Retry-After echoed for the wallet's backoff logic.
    expect(res.headers['retry-after']).toBe('17')
    // Content-Type passed through so the wallet parses as JSON.
    expect(res.headers['content-type']).toMatch(/^application\/json/)
  })

  it('T6: missing consumer key returns proxy_misconfigured (guard against silent-degrade)', async () => {
    setEnv({ TUCOPRAMP_CONSUMER_KEY_PROD: undefined })
    const res = await request(app)
      .get('/api/tucopramp/v1/p2p/banks')
      .set('X-Wallet-Address', '0x81dc')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ code: 'proxy_misconfigured' })
    expect(captured).toHaveLength(0)
  })

  it('T7: missing upstream URL returns proxy_misconfigured', async () => {
    setEnv({ TUCOPRAMP_UPSTREAM_URL: undefined })
    const res = await request(app)
      .get('/api/tucopramp/v1/p2p/banks')
      .set('X-Wallet-Address', '0x81dc')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ code: 'proxy_misconfigured' })
    expect(captured).toHaveLength(0)
  })

  it('T8: paths outside /v1/p2p/* fall through to the app 404 handler (never reach upstream)', async () => {
    // Wallet spec §2 + §7 scope the proxy to /v1/p2p/*. Any other
    // path under /api/tucopramp/* must NOT proxy: it should hit the
    // app's 404 handler so consumer-key budget is not spent on a
    // wallet mistake.
    const res = await request(app)
      .get('/api/tucopramp/admin/reset')
      .set('X-Wallet-Address', '0x81dc')
    expect(res.status).toBe(404)
    expect(captured).toHaveLength(0)
  })

  it('T9: forwards HTTP cache-semantic response headers (Cache-Control, ETag, Last-Modified, Vary)', async () => {
    // TuCOPRamp `GET /v1/p2p/limits` (guide v1.3) and `GET /v1/p2p/banks`
    // emit `Cache-Control: public, max-age=<n>`. Consumers that respect
    // HTTP caching semantics need the header to serve conditional or
    // fresh responses correctly; dropping it silently forces every hit
    // to round-trip and defeats the upstream cache hint. `ETag` +
    // `Last-Modified` support conditional GET. `Vary` keeps caches
    // honest when the response differs by consumer key.
    nextUpstreamResponse = {
      status: 200,
      body: Buffer.from(
        JSON.stringify({
          min_order_cop: 100000,
          max_order_cop: 500000,
          max_daily_cop: 1000000,
          max_monthly_cop: 3000000,
        })
      ),
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        ETag: 'W/"abc123"',
        'Last-Modified': 'Wed, 02 Sep 2026 22:40:00 GMT',
        Vary: 'X-TuCOPRamp-Key',
      },
    }
    const res = await request(app).get('/api/tucopramp/v1/p2p/limits')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    expect(res.headers['etag']).toBe('W/"abc123"')
    expect(res.headers['last-modified']).toBe('Wed, 02 Sep 2026 22:40:00 GMT')
    expect(res.headers['vary']).toBe('X-TuCOPRamp-Key')
    expect(res.headers['content-type']).toMatch(/^application\/json/)
  })

  it('T10: cache-semantic headers absent upstream are absent downstream (no synthesis)', async () => {
    // Passthrough discipline: the proxy MUST NOT invent cache headers
    // the upstream did not emit. Otherwise a wallet-side cache could
    // incorrectly hold onto data the upstream considered dynamic.
    nextUpstreamResponse = {
      status: 200,
      body: Buffer.from('{"ok":true}'),
      headers: { 'Content-Type': 'application/json' },
    }
    const res = await request(app).get('/api/tucopramp/v1/p2p/banks')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.headers['etag']).toBeUndefined()
    expect(res.headers['last-modified']).toBeUndefined()
    expect(res.headers['vary']).toBeUndefined()
  })
})
