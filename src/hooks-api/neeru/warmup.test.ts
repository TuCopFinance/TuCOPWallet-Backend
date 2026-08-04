import type { Pool } from 'pg'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import { startNeeruWarmup } from './warmup'
import * as positionsMod from './positions'

jest.spyOn(positionsMod, 'getNeeruEarnPositions').mockImplementation(async () => [])

const mockGetNeeruEarnPositions =
  positionsMod.getNeeruEarnPositions as jest.MockedFunction<
    typeof positionsMod.getNeeruEarnPositions
  >

function buildFakeDb(): {
  db: Pool
  queries: string[]
  fail: (err: Error) => void
} {
  let nextError: Error | null = null
  const queries: string[] = []
  const db = {
    query: async (sql: string) => {
      queries.push(sql)
      if (nextError) {
        const err = nextError
        nextError = null
        throw err
      }
      return { rows: [] }
    },
  } as unknown as Pool
  return {
    db,
    queries,
    fail: (err: Error) => {
      nextError = err
    },
  }
}

function buildFakeRpc(): NeeruIndexerRpcClient {
  return {
    getBlockNumber: async () => 1n,
    getBlock: async () => ({ number: 1n, timestamp: 0n }),
    getLogs: async () => [],
    multicall: (async () => []) as never,
    readContract: (async () => 0) as never,
    call: (async () => ({ data: '0x' })) as never,
  }
}

describe('startNeeruWarmup', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockGetNeeruEarnPositions.mockReset()
    mockGetNeeruEarnPositions.mockResolvedValue([])
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('fires an immediate tick + then ticks on the configured interval', async () => {
    const { db, queries } = buildFakeDb()
    const rpc = buildFakeRpc()

    const handle = startNeeruWarmup({ db, rpc, intervalMs: 100 })
    // Immediate tick is scheduled but async — flush microtasks so the
    // first tick's awaits resolve.
    await Promise.resolve()
    await Promise.resolve()
    expect(queries).toEqual(['SELECT 1'])
    expect(mockGetNeeruEarnPositions).toHaveBeenCalledTimes(1)

    // Advance timers by 100ms -> one more tick.
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    await Promise.resolve()
    expect(queries).toEqual(['SELECT 1', 'SELECT 1'])
    expect(mockGetNeeruEarnPositions).toHaveBeenCalledTimes(2)

    // Advance 300ms -> three more ticks.
    jest.advanceTimersByTime(300)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGetNeeruEarnPositions).toHaveBeenCalledTimes(5)

    handle.stop()
  })

  it('stop() prevents further ticks', async () => {
    const { db } = buildFakeDb()
    const rpc = buildFakeRpc()

    const handle = startNeeruWarmup({ db, rpc, intervalMs: 100 })
    await Promise.resolve()
    await Promise.resolve()
    const initial = mockGetNeeruEarnPositions.mock.calls.length

    handle.stop()

    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGetNeeruEarnPositions.mock.calls.length).toBe(initial)
  })

  it('respects AbortSignal - aborts stop the interval', async () => {
    const { db } = buildFakeDb()
    const rpc = buildFakeRpc()

    const ctrl = new AbortController()
    startNeeruWarmup({ db, rpc, intervalMs: 100, signal: ctrl.signal })
    await Promise.resolve()
    await Promise.resolve()
    const initial = mockGetNeeruEarnPositions.mock.calls.length

    ctrl.abort()

    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGetNeeruEarnPositions.mock.calls.length).toBe(initial)
  })

  it('does not throw when db.query fails - failure is logged, next tick still fires', async () => {
    const { db, fail } = buildFakeDb()
    const rpc = buildFakeRpc()

    fail(new Error('pool exhausted'))
    const handle = startNeeruWarmup({ db, rpc, intervalMs: 100 })
    await Promise.resolve()
    await Promise.resolve()

    // Even though db failed on the first tick, the interval keeps firing.
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGetNeeruEarnPositions.mock.calls.length).toBeGreaterThanOrEqual(1)

    handle.stop()
  })

  it('does not throw when getNeeruEarnPositions fails - failure is logged, next tick still fires', async () => {
    const { db } = buildFakeDb()
    const rpc = buildFakeRpc()

    mockGetNeeruEarnPositions.mockRejectedValueOnce(new Error('rpc down'))

    const handle = startNeeruWarmup({ db, rpc, intervalMs: 100 })
    await Promise.resolve()
    await Promise.resolve()
    // First tick called and threw — recorded once. Next tick should fire.
    jest.advanceTimersByTime(100)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGetNeeruEarnPositions.mock.calls.length).toBeGreaterThanOrEqual(2)

    handle.stop()
  })

  it('signal already aborted at start = no ticks fire on the interval', async () => {
    const { db } = buildFakeDb()
    const rpc = buildFakeRpc()

    const ctrl = new AbortController()
    ctrl.abort()
    startNeeruWarmup({ db, rpc, intervalMs: 100, signal: ctrl.signal })
    // Immediate tick fires once (scheduled synchronously before the stop
    // is applied) but no interval ticks after.
    await Promise.resolve()
    await Promise.resolve()
    const afterImmediate = mockGetNeeruEarnPositions.mock.calls.length

    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGetNeeruEarnPositions.mock.calls.length).toBe(afterImmediate)
  })
})
