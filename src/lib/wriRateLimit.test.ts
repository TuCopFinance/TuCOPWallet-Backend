import {
  _resetInMemoryStoreForTests,
  tryAcquireDelegateRelaySlot,
  tryAcquireGlobalRelaySlot,
  WRI_GLOBAL_LIMIT_WINDOW_SECONDS,
  WRI_RATE_LIMIT_WINDOW_SECONDS,
} from './wriRateLimit'

const ADDR = '0x1111111111111111111111111111111111111111'

describe('tryAcquireDelegateRelaySlot (in-memory fallback)', () => {
  beforeEach(() => {
    _resetInMemoryStoreForTests()
  })

  it('first request for an address acquires the slot', async () => {
    const result = await tryAcquireDelegateRelaySlot(null, ADDR)
    expect(result.acquired).toBe(true)
  })

  it('second request within window is rejected with ttlSeconds', async () => {
    await tryAcquireDelegateRelaySlot(null, ADDR)
    const result = await tryAcquireDelegateRelaySlot(null, ADDR)
    expect(result.acquired).toBe(false)
    expect(result.ttlSeconds).toBeGreaterThan(0)
    expect(result.ttlSeconds).toBeLessThanOrEqual(WRI_RATE_LIMIT_WINDOW_SECONDS)
  })

  it('different addresses do not collide', async () => {
    const a = await tryAcquireDelegateRelaySlot(null, ADDR)
    const b = await tryAcquireDelegateRelaySlot(
      null,
      '0x2222222222222222222222222222222222222222',
    )
    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
  })
})

describe('tryAcquireGlobalRelaySlot', () => {
  it('returns acquired=false when Redis is null (fail-closed)', async () => {
    const result = await tryAcquireGlobalRelaySlot(null, 60)
    expect(result.acquired).toBe(false)
    expect(result.ttlSeconds).toBe(WRI_GLOBAL_LIMIT_WINDOW_SECONDS)
  })

  it('acquires until limit is reached, then rejects with ttlSeconds', async () => {
    let counter = 0
    const fakeRedis = {
      incr: jest.fn(async () => ++counter),
      expire: jest.fn(async () => 1),
      ttl: jest.fn(async () => 42),
    } as unknown as Parameters<typeof tryAcquireGlobalRelaySlot>[0]

    const r1 = await tryAcquireGlobalRelaySlot(fakeRedis, 2)
    expect(r1.acquired).toBe(true)
    expect(r1.count).toBe(1)

    const r2 = await tryAcquireGlobalRelaySlot(fakeRedis, 2)
    expect(r2.acquired).toBe(true)
    expect(r2.count).toBe(2)

    const r3 = await tryAcquireGlobalRelaySlot(fakeRedis, 2)
    expect(r3.acquired).toBe(false)
    expect(r3.count).toBe(3)
    expect(r3.ttlSeconds).toBe(42)
  })

  it('sets TTL only on the first request (count === 1)', async () => {
    let counter = 0
    const expireMock = jest.fn(async () => 1)
    const fakeRedis = {
      incr: jest.fn(async () => ++counter),
      expire: expireMock,
      ttl: jest.fn(async () => 30),
    } as unknown as Parameters<typeof tryAcquireGlobalRelaySlot>[0]

    await tryAcquireGlobalRelaySlot(fakeRedis, 10)
    await tryAcquireGlobalRelaySlot(fakeRedis, 10)
    await tryAcquireGlobalRelaySlot(fakeRedis, 10)

    expect(expireMock).toHaveBeenCalledTimes(1)
  })
})
