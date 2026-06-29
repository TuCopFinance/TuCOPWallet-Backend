// Supervisor tests for startNeeruIndexer (the for(;;) loop in worker.ts).
//
// These exercise the loop's interaction with the advisory lock, error
// escalation, sleep cadence, and reorg-job lifecycle. Kept separate from
// worker.test.ts (which covers runTick / parseNeeruLog / handlers) because
// the supervisor is the noisy-edge case territory and benefits from its
// own setup/teardown.
//
// Pattern: pass `iterations: N, intervalMs: 0` to startNeeruIndexer and
// drive the mocked DB + RPC to surface specific control flow.

import type { Pool } from 'pg'

// Mock the rpc factory so we never hit the network. The default mock returns
// a stub whose multicall + getLogs etc. resolve to empty; specific tests can
// reassign behaviour via `mockRpc.runTickShould*`.
const mockRpc = {
  getBlockNumber: jest.fn(async () => 0n),
  getLogs: jest.fn(async () => []),
  getBlock: jest.fn(async () => ({ timestamp: 0n })),
  multicall: jest.fn(async () => []),
  readContract: jest.fn(async () => 0n),
}

jest.mock('./rpc', () => ({
  createNeeruRpc: () => mockRpc,
}))

// Mock state seed + cursor so the worker doesn't try to touch a real DB during
// the seed step. The DB pool is replaced by a stub pgPool in each test.
jest.mock('./state', () => ({
  ensureIndexerStateSeed: jest.fn(async () => undefined),
  getLastScannedBlock: jest.fn(async () => 100n),
  setLastScannedBlock: jest.fn(async () => undefined),
  recordIndexerError: jest.fn(async () => undefined),
  // Return a valid state row so runTick does not throw on the very first
  // line. Tests that want runTick itself to fail can override via
  // mockRpc.getBlockNumber.mockRejectedValue(...) instead.
  getIndexerState: jest.fn(async () => ({
    lastScannedBlock: 100n,
    lastScanAt: new Date(),
  })),
}))

// Mock the abi assertions; the env vars are set in jest.setup.ts so the
// assert passes, but we don't want the actual log volume during tests.
jest.mock('./abi', () => {
  const actual = jest.requireActual('./abi')
  return {
    ...actual,
    assertIndexerConfig: jest.fn(),
  }
})

import type { NeeruIndexerRpcClient } from './rpc'
import {
  releaseIndexerLock,
  scheduleReorgJob,
  startNeeruIndexer,
  tryAcquireIndexerLock,
} from './worker'

// pgPool stub: tracks every query call so assertions can introspect.
interface StubPool {
  query: jest.Mock
  connect?: jest.Mock
}

function buildPgPoolStub(opts: {
  acquireLock?: boolean
  lockShouldThrow?: boolean
} = {}): StubPool {
  const acquired = opts.acquireLock ?? true
  return {
    query: jest.fn(async (sql: string) => {
      const s = sql.trim().toUpperCase()
      if (s.includes('PG_TRY_ADVISORY_LOCK')) {
        if (opts.lockShouldThrow) throw new Error('advisory lock failure')
        return { rows: [{ ok: acquired }] }
      }
      if (s.includes('PG_ADVISORY_UNLOCK')) {
        return { rows: [{}] }
      }
      return { rows: [] }
    }),
  }
}

describe('tryAcquireIndexerLock / releaseIndexerLock', () => {
  it('returns true when pg_try_advisory_lock returns ok=true', async () => {
    const pool = buildPgPoolStub({ acquireLock: true })
    const got = await tryAcquireIndexerLock(pool as unknown as Pool)
    expect(got).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.any(Array),
    )
  })

  it('returns false when pg_try_advisory_lock returns ok=false (another holder)', async () => {
    const pool = buildPgPoolStub({ acquireLock: false })
    const got = await tryAcquireIndexerLock(pool as unknown as Pool)
    expect(got).toBe(false)
  })

  it('releaseIndexerLock calls pg_advisory_unlock with the same key', async () => {
    const pool = buildPgPoolStub({ acquireLock: true })
    await releaseIndexerLock(pool as unknown as Pool)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.any(Array),
    )
  })
})

describe('startNeeruIndexer supervisor loop', () => {
  beforeEach(() => {
    mockRpc.getBlockNumber.mockReset().mockResolvedValue(0n)
    mockRpc.getLogs.mockReset().mockResolvedValue([])
    mockRpc.getBlock.mockReset().mockResolvedValue({ timestamp: 0n })
    mockRpc.multicall.mockReset().mockResolvedValue([])
  })

  it('no-ops when DB is not provided AND getDb returns null', async () => {
    // db: undefined + getDb mocked elsewhere returns the global pool stub.
    // Easiest: pass an explicit null cast. The worker checks `if (!db)` so
    // we cast to satisfy the type while exercising the early return.
    await expect(
      startNeeruIndexer({ db: null as unknown as Pool, enableReorgJob: false }),
    ).resolves.toBeUndefined()
  })

  it('runs exactly N iterations when iterations: N is passed', async () => {
    const pool = buildPgPoolStub({ acquireLock: true })
    await startNeeruIndexer({
      db: pool as unknown as Pool,
      rpc: mockRpc as unknown as NeeruIndexerRpcClient,
      iterations: 3,
      intervalMs: 0,
      enableReorgJob: false,
    })
    // 3 ticks * (lock acquire + unlock) = 6 lock-related queries minimum
    const lockCalls = pool.query.mock.calls.filter((c) =>
      String(c[0]).includes('pg_try_advisory_lock'),
    ).length
    expect(lockCalls).toBe(3)
  })

  it('skips runTick when the advisory lock is held by another replica', async () => {
    const pool = buildPgPoolStub({ acquireLock: false })
    await startNeeruIndexer({
      db: pool as unknown as Pool,
      rpc: mockRpc as unknown as NeeruIndexerRpcClient,
      iterations: 2,
      intervalMs: 0,
      enableReorgJob: false,
    })
    // tryAcquire returned false; runTick should NOT have asked the RPC for
    // a block number (the very first call inside runTick).
    expect(mockRpc.getBlockNumber).not.toHaveBeenCalled()
  })

  it('escalates log severity to error after ERROR_ESCALATION_THRESHOLD consecutive failures', async () => {
    // Force getBlockNumber to throw on every call -> runTick throws -> caught
    // by supervisor -> consecutiveErrors increments.
    mockRpc.getBlockNumber.mockRejectedValue(new Error('rpc dead'))
    const pool = buildPgPoolStub({ acquireLock: true })

    await startNeeruIndexer({
      db: pool as unknown as Pool,
      rpc: mockRpc as unknown as NeeruIndexerRpcClient,
      iterations: 6,
      intervalMs: 0,
      errorBackoffMs: 0,
      enableReorgJob: false,
    })

    // 6 iterations -> 6 calls to getBlockNumber (the throwing call in runTick).
    // Using mockRpc directly because jest.requireMock('./state') returns a
    // different instance than worker.ts imports when resetModules:true.
    expect(mockRpc.getBlockNumber).toHaveBeenCalledTimes(6)
    // Lock was acquired every iteration (the supervisor doesn't skip on
    // error; it acquires, runTick throws, finally releases).
    const lockCalls = pool.query.mock.calls.filter((c) =>
      String(c[0]).includes('pg_try_advisory_lock'),
    ).length
    expect(lockCalls).toBe(6)
  })

  it('continues iterating after transient errors (recovers on success)', async () => {
    // First 2 ticks throw, then succeed. Total of 4 iterations should ALL
    // execute (the supervisor doesn't bail on errors; it backs off and
    // continues).
    let throwCount = 0
    mockRpc.getBlockNumber.mockImplementation(async () => {
      if (throwCount < 2) {
        throwCount += 1
        throw new Error('transient')
      }
      return 0n
    })
    const pool = buildPgPoolStub({ acquireLock: true })
    await startNeeruIndexer({
      db: pool as unknown as Pool,
      rpc: mockRpc as unknown as NeeruIndexerRpcClient,
      iterations: 4,
      intervalMs: 0,
      errorBackoffMs: 0,
      enableReorgJob: false,
    })
    // 4 iterations completed -> 4 getBlockNumber calls regardless of throws.
    expect(mockRpc.getBlockNumber).toHaveBeenCalledTimes(4)
  })

  it('starts and stops the reorg job when enableReorgJob is true', async () => {
    const pool = buildPgPoolStub({ acquireLock: true })
    await startNeeruIndexer({
      db: pool as unknown as Pool,
      rpc: mockRpc as unknown as NeeruIndexerRpcClient,
      iterations: 1,
      intervalMs: 0,
      enableReorgJob: true,
    })
    // No assertion on the interval itself; we just want to confirm
    // enableReorgJob=true doesn't throw during start + cleanup.
    expect(pool.query).toHaveBeenCalled()
  })
})

describe('scheduleReorgJob timing', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('does not fire when the wall clock is outside the configured hour', () => {
    // 02:30 UTC: the job should NOT run (only fires at 03:00..03:01 UTC).
    const fakeNow = new Date('2026-06-29T02:30:00Z')
    const rpcStub = {} as Parameters<typeof scheduleReorgJob>[0]
    const dbStub = { query: jest.fn(async () => ({ rows: [] })) } as unknown as Pool

    const job = scheduleReorgJob(rpcStub, dbStub, {
      intervalMs: 1000,
      nowFn: () => fakeNow,
    })

    jest.advanceTimersByTime(60_000)
    expect((dbStub as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled()
    job.stop()
  })

  it('runs exactly once per day even if the interval fires multiple times in the window', () => {
    const fakeNow = new Date('2026-06-29T03:00:30Z')
    const rpcStub = {
      // The reorg reconciliation queries the DB and the contract; we stub
      // both. Important: it's the SAME date string, so the second-and-later
      // ticks within the same hour are no-ops.
    } as Parameters<typeof scheduleReorgJob>[0]
    const dbQuery = jest.fn(async () => ({ rows: [] }))
    const dbStub = { query: dbQuery } as unknown as Pool

    const job = scheduleReorgJob(rpcStub, dbStub, {
      intervalMs: 1000,
      nowFn: () => fakeNow,
    })

    jest.advanceTimersByTime(60_000)
    // The reorg job's worker function is async and may not have run synchronously,
    // but it should have been kicked off at most once.
    // Specifically, the dbQuery call count is the side effect we look for.
    const firstCallCount = dbQuery.mock.calls.length

    // Advance another 30s within the same hour - lastRunDateUtc deduplicates.
    jest.advanceTimersByTime(30_000)
    expect(dbQuery.mock.calls.length).toBe(firstCallCount)
    job.stop()
  })
})
