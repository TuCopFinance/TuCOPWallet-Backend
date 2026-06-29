// Supervisor tests for the transactions indexer (startIndexer + advisory
// lock + graceful stop via AbortSignal). Closes Fase 3 PR 20.
//
// Same pattern as src/neeru-indexer/supervisor.test.ts: pass iterations:N
// + pollIntervalMs:0 + a stub Pool to drive the loop without real I/O.

import type { Pool } from 'pg'

// Stub the default RPC client builder so the worker doesn't try to reach
// Forno when tests don't pass an explicit rpc client. Each test passes its
// own mock anyway; this is just a safety net.
jest.mock('../lib/celoClient', () => ({
  createCeloPublicClient: () => ({
    getBlockNumber: async () => 0n,
    getBlock: async () => ({ timestamp: 0n, transactions: [] }),
    getTransactionReceipt: async () => ({
      status: 'success',
      transactionIndex: 0,
      gasUsed: 0n,
      effectiveGasPrice: 0n,
      logs: [],
    }),
  }),
  getFornoUrl: () => 'https://forno.celo.org',
}))

// db.getDb is called inside startIndexer at boot. Each test injects a Pool
// via the actual call to startIndexer, so the mock factory just needs to
// return SOMETHING truthy here so the `if (!db)` early return doesn't fire.
let mockDb: { query: jest.Mock } | null = null
jest.mock('../lib/db', () => ({
  getDb: () => mockDb,
}))

import {
  releaseTransactionsIndexerLock,
  startIndexer,
  TRANSACTIONS_INDEXER_ADVISORY_LOCK_KEY,
  tryAcquireTransactionsIndexerLock,
  type IndexerRpcClient,
} from './worker'

function buildPgPoolStub(opts: { acquireLock?: boolean } = {}): {
  query: jest.Mock
} {
  const acquired = opts.acquireLock ?? true
  return {
    query: jest.fn(async (sql: string) => {
      const s = sql.trim().toUpperCase()
      if (s.includes('PG_TRY_ADVISORY_LOCK')) {
        return { rows: [{ ok: acquired }] }
      }
      if (s.includes('PG_ADVISORY_UNLOCK')) {
        return { rows: [{}] }
      }
      if (s.includes('SELECT ADDRESS FROM WATCHED_ADDRESS')) {
        return { rows: [] }
      }
      if (s.includes('SELECT LAST_BLOCK FROM INDEXER_STATE')) {
        return { rows: [{ last_block: '100' }] }
      }
      if (s.includes('UPDATE INDEXER_STATE')) {
        return { rows: [] }
      }
      if (s.includes('INSERT INTO INDEXER_STATE')) {
        return { rows: [] }
      }
      return { rows: [] }
    }),
  }
}

function buildRpcStub(opts: { tip?: bigint } = {}): IndexerRpcClient {
  const tip = opts.tip ?? 100n
  return {
    getBlockNumber: jest.fn(async () => tip),
    getBlock: jest.fn(async () => ({
      timestamp: 0n,
      transactions: [] as never[],
    })),
    getTransactionReceipt: jest.fn(async () => ({
      status: 'success' as const,
      transactionIndex: 0,
      gasUsed: 0n,
      effectiveGasPrice: 0n,
      logs: [] as never[],
    })),
  }
}

describe('tryAcquireTransactionsIndexerLock / releaseTransactionsIndexerLock', () => {
  it('uses a different advisory key than the Neeru indexer', () => {
    // Hardcoded constant; this test catches accidental key reuse across the
    // two workers (which would cause one to perpetually block the other).
    expect(TRANSACTIONS_INDEXER_ADVISORY_LOCK_KEY).toBe(7320041003n)
  })

  it('returns true when pg_try_advisory_lock returns ok=true', async () => {
    const pool = buildPgPoolStub({ acquireLock: true })
    const got = await tryAcquireTransactionsIndexerLock(pool as unknown as Pool)
    expect(got).toBe(true)
  })

  it('returns false when pg_try_advisory_lock returns ok=false', async () => {
    const pool = buildPgPoolStub({ acquireLock: false })
    const got = await tryAcquireTransactionsIndexerLock(pool as unknown as Pool)
    expect(got).toBe(false)
  })

  it('releaseTransactionsIndexerLock calls pg_advisory_unlock', async () => {
    const pool = buildPgPoolStub()
    await releaseTransactionsIndexerLock(pool as unknown as Pool)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.any(Array),
    )
  })
})

describe('startIndexer supervisor loop', () => {
  beforeEach(() => {
    mockDb = null
  })

  it('no-ops when getDb returns null', async () => {
    mockDb = null
    await expect(startIndexer({ iterations: 1 })).resolves.toBeUndefined()
  })

  it('runs exactly N iterations with iterations:N', async () => {
    mockDb = buildPgPoolStub({ acquireLock: true })
    const rpc = buildRpcStub({ tip: 100n })

    await startIndexer({
      rpcClient: rpc,
      pollIntervalMs: 0,
      iterations: 3,
    })

    const lockCalls = mockDb.query.mock.calls.filter((c) =>
      String(c[0]).includes('pg_try_advisory_lock'),
    ).length
    expect(lockCalls).toBe(3)
  })

  it('skips the tick when another replica holds the advisory lock', async () => {
    mockDb = buildPgPoolStub({ acquireLock: false })
    const rpc = buildRpcStub()

    await startIndexer({
      rpcClient: rpc,
      pollIntervalMs: 0,
      iterations: 2,
    })

    // tryAcquire returned false; rpc.getBlockNumber (the first call inside
    // a tick after the lock acquire) should NOT have been called.
    expect(rpc.getBlockNumber).not.toHaveBeenCalled()
  })

  it('exits the loop gracefully when the AbortSignal aborts', async () => {
    mockDb = buildPgPoolStub({ acquireLock: true })
    const rpc = buildRpcStub({ tip: 100n })
    const controller = new AbortController()
    // Abort immediately so the loop exits on the first signal check
    // (before iterations:N is reached).
    controller.abort()

    await startIndexer({
      rpcClient: rpc,
      pollIntervalMs: 0,
      iterations: 100,
      signal: controller.signal,
    })

    // The abort check is at the top of the loop, so getBlockNumber should
    // NOT have been called even once.
    expect(rpc.getBlockNumber).not.toHaveBeenCalled()
  })

  it('completes the current tick before exiting on a late abort', async () => {
    mockDb = buildPgPoolStub({ acquireLock: true })
    const rpc = buildRpcStub({ tip: 100n })
    const controller = new AbortController()

    // Abort after rpc.getBlockNumber has been called once. The supervisor
    // does the signal check at the TOP of each iteration, so after the
    // current tick completes, the next iteration's signal check exits.
    let firstCallSeen = false
    ;(rpc.getBlockNumber as jest.Mock).mockImplementation(async () => {
      if (!firstCallSeen) {
        firstCallSeen = true
        controller.abort()
      }
      return 100n
    })

    await startIndexer({
      rpcClient: rpc,
      pollIntervalMs: 0,
      iterations: 100,
      signal: controller.signal,
    })

    // One full tick ran (lock acquired, getBlockNumber called, lock
    // released), then iteration 2's signal-aborted check exited cleanly.
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(1)
    const unlockCalls = mockDb.query.mock.calls.filter((c) =>
      String(c[0]).includes('pg_advisory_unlock'),
    ).length
    expect(unlockCalls).toBe(1)
  })

  it('continues iterating after transient errors', async () => {
    mockDb = buildPgPoolStub({ acquireLock: true })
    const rpc = buildRpcStub({ tip: 100n })
    let throwCount = 0
    ;(rpc.getBlockNumber as jest.Mock).mockImplementation(async () => {
      if (throwCount < 2) {
        throwCount += 1
        throw new Error('transient')
      }
      return 100n
    })

    await startIndexer({
      rpcClient: rpc,
      pollIntervalMs: 0,
      iterations: 4,
    })

    // 4 iterations completed regardless of throws.
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(4)
  })
})
