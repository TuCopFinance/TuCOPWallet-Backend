import { createHmac } from 'crypto'
import request from 'supertest'
import { Webhook } from 'standardwebhooks'
import { _resetParsedEnvForTests } from '../lib/env'

// A real Standard Webhooks secret shape: `whsec_` + base64 of 32 bytes. Test
// material only; the production value lives in Railway and is never logged.
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
const OTHER_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`

const mockQuery = jest.fn()
let dbMode: 'happy' | 'disabled' | 'throws' = 'happy'

jest.mock('../lib/db', () => ({
  getDb: () => {
    if (dbMode === 'disabled') return null
    return { query: mockQuery }
  },
}))

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

const WEBHOOK_URL = '/api/tucopramp/webhooks/p2p'

function orderEnvelope(
  overrides: Partial<{
    order_id: string
    kind: string
    status: string
    updated_at: string
  }> = {},
): string {
  return JSON.stringify({
    id: 'evt_2a7f9c',
    type: 'p2p_order.updated',
    category: 'p2p',
    timestamp: '2026-11-07T05:00:00.000Z',
    api_version: '2026-10-08',
    data: {
      order_id: overrides.order_id ?? '8f14e45f-ceea-467a-9f0b-6c3a1f2d4e55',
      kind: overrides.kind ?? 'onramp',
      status: overrides.status ?? 'AWAITING_PROOF',
      tx_hash: null,
      refund_tx_hash: null,
      updated_at: overrides.updated_at ?? '2026-11-07T05:00:00.000Z',
    },
  })
}

// Sign the way upstream does: the signed content is
// `<webhook-id>.<webhook-timestamp>.<raw body>`, not the body alone.
function signedHeaders(
  body: string,
  opts: { secrets?: string[]; msgId?: string; atMs?: number } = {},
): Record<string, string> {
  const secrets = opts.secrets ?? [SECRET]
  const msgId = opts.msgId ?? 'evt_2a7f9c'
  const atMs = opts.atMs ?? Date.now()
  const at = new Date(atMs)
  const signature = secrets.map((s) => new Webhook(s).sign(msgId, at, body)).join(' ')
  return {
    'webhook-id': msgId,
    'webhook-timestamp': String(Math.floor(atMs / 1000)),
    'webhook-signature': signature,
    'content-type': 'application/json',
  }
}

function post(body: string, headers: Record<string, string>) {
  const req = request(app).post(WEBHOOK_URL)
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  return req.send(body)
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [] })
  dbMode = 'happy'
  setEnv({ TUCOPRAMP_WEBHOOK_SECRET_P2P: SECRET })
})

afterEach(() => {
  setEnv({ TUCOPRAMP_WEBHOOK_SECRET_P2P: undefined })
})

import { app } from '../app'

describe('POST /api/tucopramp/webhooks/p2p signature', () => {
  it('accepts a correctly signed delivery', async () => {
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('rejects a signature computed over the body alone', async () => {
    // The classic mistake: HMAC over the payload without the id and the
    // timestamp. It must not verify.
    const body = orderEnvelope()
    const headers = signedHeaders(body)
    headers['webhook-signature'] = `v1,${createHmac(
      'sha256',
      Buffer.from(SECRET.slice('whsec_'.length), 'base64'),
    )
      .update(body)
      .digest('base64')}`
    const res = await post(body, headers)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ code: 'signature_invalid' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a signature made with a different secret', async () => {
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body, { secrets: [OTHER_SECRET] }))
    expect(res.status).toBe(401)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a tampered body under a valid signature', async () => {
    const body = orderEnvelope()
    const headers = signedHeaders(body)
    const tampered = orderEnvelope({ status: 'COMPLETED' })
    const res = await post(tampered, headers)
    expect(res.status).toBe(401)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a delivery whose webhook-id does not match the signature', async () => {
    const body = orderEnvelope()
    const headers = signedHeaders(body)
    headers['webhook-id'] = 'evt_somethingelse'
    const res = await post(body, headers)
    expect(res.status).toBe(401)
  })

  it.each([
    ['webhook-id', 'webhook-id'],
    ['webhook-timestamp', 'webhook-timestamp'],
    ['webhook-signature', 'webhook-signature'],
  ])('rejects a delivery missing %s', async (_label, header) => {
    const body = orderEnvelope()
    const headers = signedHeaders(body)
    delete headers[header]
    const res = await post(body, headers)
    expect(res.status).toBe(401)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a timestamp older than the 5 minute window', async () => {
    const body = orderEnvelope()
    const res = await post(
      body,
      signedHeaders(body, { atMs: Date.now() - 6 * 60_000 }),
    )
    expect(res.status).toBe(401)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a timestamp too far in the future', async () => {
    const body = orderEnvelope()
    const res = await post(
      body,
      signedHeaders(body, { atMs: Date.now() + 6 * 60_000 }),
    )
    expect(res.status).toBe(401)
  })

  it('accepts a timestamp just inside the window', async () => {
    const body = orderEnvelope()
    const res = await post(
      body,
      signedHeaders(body, { atMs: Date.now() - 4 * 60_000 }),
    )
    expect(res.status).toBe(200)
  })

  it('accepts when one of several rotated signatures matches', async () => {
    // During a rotation upstream sends one signature per secret, space
    // separated, and the receiver accepts if ANY of them matches.
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body, { secrets: [OTHER_SECRET, SECRET] }))
    expect(res.status).toBe(200)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('accepts when the matching signature comes first', async () => {
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body, { secrets: [SECRET, OTHER_SECRET] }))
    expect(res.status).toBe(200)
  })

  it('rejects when no signature in the list matches', async () => {
    const body = orderEnvelope()
    const res = await post(
      body,
      signedHeaders(body, { secrets: [OTHER_SECRET, OTHER_SECRET] }),
    )
    expect(res.status).toBe(401)
  })

  it('ignores a signature at an unknown version', async () => {
    const body = orderEnvelope()
    const headers = signedHeaders(body)
    headers['webhook-signature'] = headers['webhook-signature']!.replace('v1,', 'v2,')
    const res = await post(body, headers)
    expect(res.status).toBe(401)
  })

  it('never answers 410 (upstream reads 410 as "endpoint gone" and disables it)', async () => {
    const body = orderEnvelope()
    for (const res of [
      await post(body, signedHeaders(body)),
      await post(body, signedHeaders(body, { secrets: [OTHER_SECRET] })),
      await post('not json', signedHeaders('not json')),
    ]) {
      expect(res.status).not.toBe(410)
    }
  })
})

describe('POST /api/tucopramp/webhooks/p2p persistence', () => {
  it('stores order_id, kind, status and updated_at under an idempotent insert', async () => {
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(200)
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain('INSERT INTO tucopramp_webhook_events')
    expect(sql).toContain('ON CONFLICT (external_ref) DO NOTHING')
    expect(params).toEqual([
      'p2p_order.updated:8f14e45f-ceea-467a-9f0b-6c3a1f2d4e55:AWAITING_PROOF:2026-11-07T05:00:00.000Z',
      '8f14e45f-ceea-467a-9f0b-6c3a1f2d4e55',
      'onramp',
      'AWAITING_PROOF',
      '2026-11-07T05:00:00.000Z',
    ])
  })

  it('keys dedupe on order_id + status + updated_at, not order_id + status', async () => {
    // An order can come back to a status it already had: a rejected proof
    // sent again puts it back to AWAITING_PROOF and is announced again.
    // Deduplicating on order_id + status would swallow the second notice and
    // freeze the order in the UI.
    const first = orderEnvelope({ updated_at: '2026-11-07T05:00:00.000Z' })
    await post(first, signedHeaders(first))
    const second = orderEnvelope({ updated_at: '2026-11-07T06:30:00.000Z' })
    await post(second, signedHeaders(second))

    const refs = mockQuery.mock.calls.map((c) => c[1][0])
    expect(refs).toHaveLength(2)
    expect(refs[0]).not.toBe(refs[1])
    expect(refs[0]).toContain(':AWAITING_PROOF:2026-11-07T05:00:00.000Z')
    expect(refs[1]).toContain(':AWAITING_PROOF:2026-11-07T06:30:00.000Z')
  })

  it('produces the same external_ref for a redelivery of one event', async () => {
    // The other half of the key's job: an upstream retry is a no-op.
    const body = orderEnvelope()
    await post(body, signedHeaders(body))
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] })
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    const refs = mockQuery.mock.calls.map((c) => c[1][0])
    expect(refs[0]).toBe(refs[1])
  })

  it('answers 200 when the row already existed (rowCount 0)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] })
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
  })

  it('distinguishes two different statuses of the same order', async () => {
    const a = orderEnvelope({ status: 'AWAITING_PROOF' })
    await post(a, signedHeaders(a))
    const b = orderEnvelope({ status: 'COMPLETED' })
    await post(b, signedHeaders(b))
    const refs = mockQuery.mock.calls.map((c) => c[1][0])
    expect(refs[0]).not.toBe(refs[1])
  })

  it('asks upstream to retry when the write fails', async () => {
    // A failed write means the event is NOT recorded, so the retry is wanted.
    mockQuery.mockRejectedValue(new Error('connection terminated'))
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ code: 'webhook_storage_unavailable' })
  })

  it('asks upstream to retry when there is no database configured', async () => {
    dbMode = 'disabled'
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ code: 'webhook_storage_unavailable' })
  })
})

describe('POST /api/tucopramp/webhooks/p2p payload handling', () => {
  it('reads the order fields from data, not the envelope root', async () => {
    // The delivered body is an envelope; the order fields are nested under
    // `data`. Reading the root would store nothing.
    const flat = JSON.stringify({
      id: 'evt_2a7f9c',
      type: 'p2p_order.updated',
      order_id: 'root-level-id',
      status: 'COMPLETED',
      kind: 'onramp',
      updated_at: '2026-11-07T05:00:00.000Z',
    })
    const res = await post(flat, signedHeaders(flat))
    expect(res.status).toBe(200)
    // No `data`, so nothing to store: accepted and recorded as ignored.
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts and ignores the console ping event', async () => {
    // `ping` is delivered whatever the category filter says.
    const ping = JSON.stringify({
      id: 'evt_ping',
      type: 'ping',
      category: 'platform',
      timestamp: '2026-11-07T05:00:00.000Z',
      api_version: '',
      data: {},
    })
    const res = await post(ping, signedHeaders(ping, { msgId: 'evt_ping' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts and ignores an event type we do not handle', async () => {
    const other = JSON.stringify({
      id: 'evt_x',
      type: 'deposit.received',
      category: 'on_off_ramp',
      data: { deposit_id: 'dep_1' },
    })
    const res = await post(other, signedHeaders(other, { msgId: 'evt_x' }))
    expect(res.status).toBe(200)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts an authentic body that is not JSON rather than failing the endpoint', async () => {
    // Upstream disables an endpoint that keeps failing, so an authentic
    // delivery never earns a 4xx or 5xx from us: it is recorded and alerted.
    const res = await post('definitely not json', signedHeaders('definitely not json'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('accepts an authentic JSON body that is not an object', async () => {
    const res = await post('[1,2,3]', signedHeaders('[1,2,3]'))
    expect(res.status).toBe(200)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it.each(['order_id', 'kind', 'status', 'updated_at'])(
    'accepts but stores nothing when data.%s is missing',
    async (field) => {
      const payload = JSON.parse(orderEnvelope()) as {
        data: Record<string, unknown>
      }
      delete payload.data[field]
      const body = JSON.stringify(payload)
      const res = await post(body, signedHeaders(body))
      expect(res.status).toBe(200)
      expect(mockQuery).not.toHaveBeenCalled()
    },
  )

  it('accepts but stores nothing when updated_at is not a date', async () => {
    const body = orderEnvelope({ updated_at: 'yesterday-ish' })
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(200)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('stores an offramp event the same way', async () => {
    const body = orderEnvelope({ kind: 'offramp', status: 'COMPLETED' })
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(200)
    expect(mockQuery.mock.calls[0]![1][2]).toBe('offramp')
  })
})

describe('POST /api/tucopramp/webhooks/p2p configuration', () => {
  it('answers 503 while the secret is unset, so upstream keeps retrying', async () => {
    setEnv({ TUCOPRAMP_WEBHOOK_SECRET_P2P: undefined })
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ code: 'webhook_not_configured' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('answers 503 when the configured secret is unusable', async () => {
    setEnv({ TUCOPRAMP_WEBHOOK_SECRET_P2P: 'whsec_' })
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ code: 'webhook_not_configured' })
  })

  it('never echoes the secret in a response body', async () => {
    const body = orderEnvelope()
    for (const res of [
      await post(body, signedHeaders(body)),
      await post(body, signedHeaders(body, { secrets: [OTHER_SECRET] })),
    ]) {
      expect(JSON.stringify(res.body)).not.toContain('whsec_')
      expect(JSON.stringify(res.body)).not.toContain(SECRET.slice(6, 20))
    }
  })

  it('is not gated by the proxy kill switch', async () => {
    // Turning the ramp off must not start discarding notices for orders that
    // are already open.
    setEnv({ TUCOPRAMP_PROXY_ENABLED: 'false', TUCOPRAMP_WEBHOOK_SECRET_P2P: SECRET })
    const body = orderEnvelope()
    const res = await post(body, signedHeaders(body))
    expect(res.status).toBe(200)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    setEnv({ TUCOPRAMP_PROXY_ENABLED: undefined })
  })

  it('is not reachable with GET', async () => {
    const res = await request(app).get(WEBHOOK_URL)
    expect(res.status).toBe(404)
  })
})
