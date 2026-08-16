import request from 'supertest'
import { app } from '../app'
import * as priceProviders from '../lib/priceProviders'
import * as redisMod from '../lib/redis'

jest.mock('../lib/priceProviders')

// Redis is mocked as a simple in-memory Map per test so we can exercise the
// fresh/stale write paths without a real Redis server. Individual tests can
// override getRedis to return null to simulate a Redis-less deployment.
jest.mock('../lib/redis', () => ({
  getRedis: jest.fn(),
}))

const mockFetchSingleTokenPrice =
  priceProviders.fetchSingleTokenPrice as jest.MockedFunction<
    typeof priceProviders.fetchSingleTokenPrice
  >
const mockGetRedis = redisMod.getRedis as jest.MockedFunction<
  typeof redisMod.getRedis
>

interface StoreEntry {
  value: string
  expiresAtMs: number
}

function buildFakeRedis(): {
  fake: {
    get: (key: string) => Promise<string | null>
    set: (
      key: string,
      value: string,
      mode: 'EX',
      seconds: number,
    ) => Promise<'OK'>
  }
  seed: (key: string, payload: unknown, ttlSeconds: number) => void
} {
  const store = new Map<string, StoreEntry>()
  return {
    fake: {
      get: async (key: string) => {
        const entry = store.get(key)
        if (!entry) return null
        if (entry.expiresAtMs <= Date.now()) {
          store.delete(key)
          return null
        }
        return entry.value
      },
      set: async (
        key: string,
        value: string,
        _mode: 'EX',
        seconds: number,
      ) => {
        store.set(key, {
          value,
          expiresAtMs: Date.now() + seconds * 1000,
        })
        return 'OK' as const
      },
    },
    seed: (key: string, payload: unknown, ttlSeconds: number) => {
      store.set(key, {
        value: JSON.stringify(payload),
        expiresAtMs: Date.now() + ttlSeconds * 1000,
      })
    },
  }
}

describe('GET /api/prices/xaut', () => {
  beforeEach(() => {
    mockFetchSingleTokenPrice.mockReset()
    mockGetRedis.mockReset()
    mockGetRedis.mockReturnValue(null)
  })

  it('returns USD price with required shape', async () => {
    const fetchedAtMs = new Date('2026-06-16T12:00:00.000Z').getTime()
    mockFetchSingleTokenPrice.mockResolvedValueOnce({
      priceUsd: 3421.5,
      source: 'dia',
      fetchedAtMs,
    })

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      symbol: 'XAUT',
      vs: 'usd',
      priceUsd: 3421.5,
      asOf: '2026-06-16T12:00:00.000Z',
      source: 'dia',
    })
    // Cache-Control matches the fresh Redis TTL so mobile OS + HTTP proxies
    // may short-circuit repeat calls within the same minute.
    expect(res.headers['cache-control']).toBe('max-age=60')
    // X-Provider-Source lets the wallet render a "degraded" badge if the
    // waterfall fell back to a lower tier (e.g. `hardcoded`, `stale-cache`).
    expect(res.headers['x-provider-source']).toBe('dia')
  })

  it('defaults to usd when vs is omitted', async () => {
    mockFetchSingleTokenPrice.mockResolvedValueOnce({
      priceUsd: 3500,
      source: 'dia',
      fetchedAtMs: Date.now(),
    })

    const res = await request(app).get('/api/prices/xaut')

    expect(res.status).toBe(200)
    expect(res.body.vs).toBe('usd')
  })

  it('rejects non-usd vs param', async () => {
    const res = await request(app).get('/api/prices/xaut?vs=cop')
    expect(res.status).toBe(400)
    expect(mockFetchSingleTokenPrice).not.toHaveBeenCalled()
  })

  it('returns 502 when waterfall returns null and no cached copy exists', async () => {
    mockFetchSingleTokenPrice.mockResolvedValueOnce(null)

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ error: expect.any(String) })
    expect(res.headers['x-stale']).toBeUndefined()
  })

  it('returns 502 when waterfall throws and no cached copy exists', async () => {
    mockFetchSingleTokenPrice.mockRejectedValueOnce(
      new Error('all providers exhausted'),
    )

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ error: expect.any(String) })
    expect(res.headers['x-stale']).toBeUndefined()
  })

  it('writes both fresh and stale cache keys on successful upstream fetch', async () => {
    const { fake } = buildFakeRedis()
    const setSpy = jest.spyOn(fake, 'set')
    mockGetRedis.mockReturnValue(
      fake as unknown as ReturnType<typeof redisMod.getRedis>,
    )
    const fetchedAtMs = new Date('2026-07-27T02:57:05.000Z').getTime()
    mockFetchSingleTokenPrice.mockResolvedValueOnce({
      priceUsd: 4082.17,
      source: 'coingecko',
      fetchedAtMs,
    })

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(200)
    // Fresh key: 60s TTL. Stale key: 24h TTL.
    const calls = setSpy.mock.calls
    expect(calls).toHaveLength(2)
    const fresh = calls[0]!
    const stale = calls[1]!
    expect(fresh[0]).toBe('price:xaut:usd:fresh')
    expect(fresh[3]).toBe(60)
    expect(stale[0]).toBe('price:xaut:usd:stale')
    expect(stale[3]).toBe(24 * 60 * 60)
  })

  it('serves fresh cache without hitting upstream when fresh key exists', async () => {
    const { fake, seed } = buildFakeRedis()
    mockGetRedis.mockReturnValue(
      fake as unknown as ReturnType<typeof redisMod.getRedis>,
    )
    seed(
      'price:xaut:usd:fresh',
      {
        symbol: 'XAUT',
        vs: 'usd',
        priceUsd: 4000,
        asOf: '2026-07-27T02:00:00.000Z',
        source: 'coingecko',
      },
      60,
    )

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(200)
    expect(res.body.priceUsd).toBe(4000)
    expect(mockFetchSingleTokenPrice).not.toHaveBeenCalled()
    // Fresh path emits no stale headers.
    expect(res.headers['x-stale']).toBeUndefined()
    // But it DOES emit Cache-Control + X-Provider-Source hydrated from the
    // cached payload's `source` field.
    expect(res.headers['cache-control']).toBe('max-age=60')
    expect(res.headers['x-provider-source']).toBe('coingecko')
  })

  it('serves stale-cache with X-Stale headers when upstream fails but stale key exists', async () => {
    const { fake, seed } = buildFakeRedis()
    mockGetRedis.mockReturnValue(
      fake as unknown as ReturnType<typeof redisMod.getRedis>,
    )
    // Fresh key absent (expired), stale key populated with a 5-minute-old
    // asOf so we can assert the X-Stale-Age header.
    const fiveMinutesAgoIso = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    seed(
      'price:xaut:usd:stale',
      {
        symbol: 'XAUT',
        vs: 'usd',
        priceUsd: 4050,
        asOf: fiveMinutesAgoIso,
      },
      24 * 60 * 60,
    )
    mockFetchSingleTokenPrice.mockRejectedValueOnce(new Error('all providers down'))

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(200)
    expect(res.body.priceUsd).toBe(4050)
    expect(res.headers['x-stale']).toBe('true')
    expect(res.headers['x-provider-source']).toBe('stale-cache')
    // Stale age is at least 300s (5 min), with a bit of slack for test
    // execution time.
    const staleAge = Number(res.headers['x-stale-age'])
    expect(staleAge).toBeGreaterThanOrEqual(300)
    expect(staleAge).toBeLessThan(360)
    expect(res.headers['cache-control']).toBe('max-age=0, must-revalidate')
  })

  it('falls through to 502 when upstream fails and stale key is empty', async () => {
    const { fake } = buildFakeRedis()
    mockGetRedis.mockReturnValue(
      fake as unknown as ReturnType<typeof redisMod.getRedis>,
    )
    mockFetchSingleTokenPrice.mockRejectedValueOnce(new Error('all providers down'))

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(502)
    expect(res.headers['x-stale']).toBeUndefined()
  })
})
