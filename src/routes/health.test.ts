import request from 'supertest'

const mockQuery = jest.fn()
const mockPing = jest.fn()
const mockGetBlockNumber = jest.fn()
const mockGetBalance = jest.fn()

let dbStub: { query: jest.Mock } | null = { query: mockQuery }
let redisStub: { ping: jest.Mock } | null = { ping: mockPing }
let relayStub: { account: { address: string }; publicClient: { getBalance: jest.Mock } } | null = {
  account: { address: '0xfacefacefacefacefacefacefacefacefaceface' },
  publicClient: { getBalance: mockGetBalance },
}

jest.mock('../lib/db', () => ({ getDb: () => dbStub }))
jest.mock('../lib/redis', () => ({ getRedis: () => redisStub }))
jest.mock('../lib/celoClient', () => {
  const actual = jest.requireActual('../lib/celoClient')
  return {
    ...actual,
    getCeloPublicClient: () => ({ getBlockNumber: mockGetBlockNumber }),
  }
})
jest.mock('../lib/wriRelay', () => ({ getRelayClients: () => relayStub }))

import { app } from '../app'

describe('GET /health', () => {
  it('always returns 200 with static service info (liveness)', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, service: 'tucopwallet-backend' })
  })
})

describe('GET /ready', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockPing.mockReset()
    mockGetBlockNumber.mockReset()
    dbStub = { query: mockQuery }
    redisStub = { ping: mockPing }
  })

  it('returns 200 when all deps are healthy', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] })
    mockPing.mockResolvedValue('PONG')
    mockGetBlockNumber.mockResolvedValue(123n)

    const res = await request(app).get('/ready')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      checks: { db: 'ok', redis: 'ok', rpc: 'ok' },
    })
  })

  it('returns 503 when db fails', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'))
    mockPing.mockResolvedValue('PONG')
    mockGetBlockNumber.mockResolvedValue(123n)

    const res = await request(app).get('/ready')
    expect(res.status).toBe(503)
    expect(res.body.ok).toBe(false)
    expect(res.body.checks.db).toMatch(/fail/)
    expect(res.body.checks.redis).toBe('ok')
    expect(res.body.checks.rpc).toBe('ok')
  })

  it('returns 503 when redis fails', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] })
    mockPing.mockRejectedValue(new Error('redis down'))
    mockGetBlockNumber.mockResolvedValue(123n)

    const res = await request(app).get('/ready')
    expect(res.status).toBe(503)
    expect(res.body.checks.redis).toMatch(/fail/)
  })

  it('returns 503 when rpc fails', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] })
    mockPing.mockResolvedValue('PONG')
    mockGetBlockNumber.mockRejectedValue(new Error('forno 500'))

    const res = await request(app).get('/ready')
    expect(res.status).toBe(503)
    expect(res.body.checks.rpc).toMatch(/fail/)
  })

  it('treats unconfigured db + redis as healthy (optional deps)', async () => {
    dbStub = null
    redisStub = null
    mockGetBlockNumber.mockResolvedValue(123n)

    const res = await request(app).get('/ready')
    expect(res.status).toBe(200)
    expect(res.body.checks).toEqual({ db: 'ok', redis: 'ok', rpc: 'ok' })
  })
})

describe('GET /health/relay', () => {
  beforeEach(() => {
    mockGetBalance.mockReset()
    relayStub = {
      account: { address: '0xfacefacefacefacefacefacefacefacefaceface' },
      publicClient: { getBalance: mockGetBalance },
    }
  })

  it('returns address + balance when relay is configured', async () => {
    mockGetBalance.mockResolvedValue(10n * 10n ** 18n)
    const res = await request(app).get('/health/relay')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.address).toBe('0xfacefacefacefacefacefacefacefacefaceface')
    expect(res.body.balanceWei).toBe('10000000000000000000')
    expect(res.body.balanceCelo).toBe('10')
  })

  it('returns 503 when relay is not configured', async () => {
    relayStub = null
    const res = await request(app).get('/health/relay')
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/relay not configured/)
  })

  it('returns 502 when the rpc probe fails', async () => {
    mockGetBalance.mockRejectedValue(new Error('rpc down'))
    const res = await request(app).get('/health/relay')
    expect(res.status).toBe(502)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('rpc unavailable')
    expect(res.body.address).toBe('0xfacefacefacefacefacefacefacefacefaceface')
  })
})

describe('GET /metrics', () => {
  beforeEach(() => {
    mockGetBalance.mockReset()
    relayStub = {
      account: { address: '0xfacefacefacefacefacefacefacefacefaceface' },
      publicClient: { getBalance: mockGetBalance },
    }
  })

  it('returns prometheus-formatted metrics including default + custom series', async () => {
    mockGetBalance.mockResolvedValue(5n * 10n ** 18n)
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain|application\/openmetrics-text/)
    const body = res.text
    // Default node metrics
    expect(body).toMatch(/process_cpu_user_seconds_total/)
    // Custom HTTP duration histogram (this very request feeds it)
    expect(body).toMatch(/http_request_duration_seconds/)
    // Custom WRI gauges
    expect(body).toMatch(/wri_relay_balance_celo/)
    // pg pool gauges (set to 0 since db is mocked)
    expect(body).toMatch(/pg_pool_total/)
  })
})
