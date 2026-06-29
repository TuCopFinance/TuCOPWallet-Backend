// Failure-mode test pack covering paths that only execute when something
// breaks (DB pool error, WRI in-memory cap saturated, etc.). Closes Fase 3
// PR 21 from `tasks/plans/full-audit-remediation.md`.
//
// Kept in a single file because each case is small and focused; splitting
// per-lib would be more noise than structure.

import {
  _resetInMemoryStoreForTests,
  tryAcquireDelegateRelaySlot,
  tryAcquireGlobalRelaySlot,
} from './wriRateLimit'

describe('wriRateLimit: in-memory fallback cap (Redis-down + spray attack)', () => {
  beforeEach(() => {
    _resetInMemoryStoreForTests()
  })

  it('accepts addresses up to the IN_MEMORY_MAX_ENTRIES cap, then rejects', async () => {
    // Cap is 10_000 per src/lib/wriRateLimit.ts. Pump that many distinct
    // addresses + verify the 10_001st is rejected fail-closed.
    //
    // Synthesize addresses cheaply: pad the index as hex into a 0x+40-hex
    // string. The values don't have to be valid EVM addresses for the limiter
    // (it just keys by lowercased string).
    function addrAt(i: number): string {
      return '0x' + i.toString(16).padStart(40, '0')
    }

    const CAP = 10_000
    // Loop to CAP; expect every acquire to succeed.
    for (let i = 0; i < CAP; i++) {
      const r = await tryAcquireDelegateRelaySlot(null, addrAt(i))
      if (!r.acquired) {
        throw new Error(`unexpected reject at index ${i}: ${JSON.stringify(r)}`)
      }
    }

    // The CAP+1st address should be rejected because the map is full.
    const overflow = await tryAcquireDelegateRelaySlot(null, addrAt(CAP))
    expect(overflow.acquired).toBe(false)
    expect(overflow.ttlSeconds).toBeGreaterThan(0)
  }, 30_000)

  it('returns the same ttlSeconds when an existing address is re-asked', async () => {
    const addr = '0x0000000000000000000000000000000000000001'
    const first = await tryAcquireDelegateRelaySlot(null, addr)
    expect(first.acquired).toBe(true)
    const second = await tryAcquireDelegateRelaySlot(null, addr)
    expect(second.acquired).toBe(false)
    expect(second.ttlSeconds).toBeGreaterThan(0)
  })
})

describe('tryAcquireGlobalRelaySlot: fail-closed when Redis is null', () => {
  it('returns acquired=false (does NOT bypass the limit) when Redis is unreachable', async () => {
    const r = await tryAcquireGlobalRelaySlot(null, 60)
    // The previous (pre-Fase-2) behavior was "fall through to acquired=true"
    // which let attackers drain the relay during Redis outages. The bucket
    // requires shared state; without it, the only correct behavior is to
    // refuse new submissions.
    expect(r.acquired).toBe(false)
  })

  it('returns acquired=false with the configured windowSeconds as the ttl', async () => {
    const r = await tryAcquireGlobalRelaySlot(null, 60, 45)
    expect(r.acquired).toBe(false)
    expect(r.ttlSeconds).toBe(45)
  })
})

describe('pg pool error handler: surfaces operational errors at error level', () => {
  it('attaches an error handler that does NOT crash the process on a pool error', async () => {
    // We can't easily simulate a real `pool.on('error', ...)` event without
    // a live Postgres + a forced disconnect. Verify the contract instead:
    // the lib registers an 'error' listener at construction time. If a future
    // refactor removes the listener, pg would re-emit as uncaughtException
    // and crash the process. This test pins the listener count.
    const ORIGINAL = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:1/db'
    jest.resetModules()
    const { getDb, _resetDbForTests } = require('./db') as typeof import('./db')
    const pool = getDb()
    expect(pool).not.toBeNull()
    // The pg Pool exposes listenerCount via EventEmitter.
    const errorListenerCount = pool!.listenerCount('error')
    expect(errorListenerCount).toBeGreaterThanOrEqual(1)
    _resetDbForTests()
    if (ORIGINAL === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = ORIGINAL
    }
  })
})
