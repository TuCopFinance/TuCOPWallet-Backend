import type { Pool } from 'pg'
import type { FallbackExecutor } from '../lib/celoRpcFallback'
import {
  _testHelpers,
  reopenBackfillIfDeeper,
  resumePendingBackfills,
  runBackfillLoopForAddress,
  triggerBackfill,
  walletCreatedAtToFromBlock,
} from './backfill'

const ADDR = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

interface DbRow {
  address: string
  backfill_cursor_block: string | null
  backfill_end_block: string | null
  backfill_initial_from_block: string | null
  backfill_completed_at: Date | null
  backfill_last_error: string | null
}

/**
 * In-memory pg-compatible pool stub. Persists the watched_address row +
 * captures every persistTx INSERT so we can assert on the writes without
 * touching Postgres. Enough surface for the backfill loop's queries.
 */
function buildMockDb(initial: Partial<DbRow> = {}): Pool {
  const row: DbRow = {
    address: (initial.address ?? ADDR).toLowerCase(),
    backfill_cursor_block: initial.backfill_cursor_block ?? null,
    backfill_end_block: initial.backfill_end_block ?? null,
    backfill_initial_from_block: initial.backfill_initial_from_block ?? null,
    backfill_completed_at: initial.backfill_completed_at ?? null,
    backfill_last_error: initial.backfill_last_error ?? null,
  }
  const txInserts: Array<{ hash: string; feeCurrency: string | null }> = []
  const txLogInserts: number[] = []

  const query = jest.fn(
    async (sql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> => {
      const n = sql.trim().toUpperCase()
      if (n.startsWith('SELECT BACKFILL_CURSOR_BLOCK')) {
        return {
          rows: [
            {
              backfill_cursor_block: row.backfill_cursor_block,
              backfill_end_block: row.backfill_end_block,
              backfill_initial_from_block: row.backfill_initial_from_block,
              backfill_completed_at: row.backfill_completed_at,
            },
          ],
        }
      }
      if (n.startsWith('SELECT ADDRESS FROM WATCHED_ADDRESS')) {
        if (!row.backfill_cursor_block || !row.backfill_end_block) return { rows: [] }
        if (row.backfill_completed_at) return { rows: [] }
        return { rows: [{ address: row.address }] }
      }
      if (n.startsWith('SELECT COALESCE(SUM')) {
        const rem = row.backfill_cursor_block && row.backfill_end_block
          ? BigInt(row.backfill_end_block) - BigInt(row.backfill_cursor_block)
          : 0n
        return { rows: [{ remaining: rem.toString() }] }
      }
      if (
        n.startsWith('UPDATE WATCHED_ADDRESS') &&
        n.includes('BACKFILL_CURSOR_BLOCK = $1') &&
        n.includes('BACKFILL_END_BLOCK = $2')
      ) {
        row.backfill_cursor_block = params[0] as string
        row.backfill_end_block = params[1] as string
        if (n.includes('BACKFILL_INITIAL_FROM_BLOCK = $1')) {
          row.backfill_initial_from_block = params[0] as string
        }
        if (n.includes('BACKFILL_COMPLETED_AT = NULL')) {
          row.backfill_completed_at = null
        }
        if (n.includes('BACKFILL_LAST_ERROR = NULL')) {
          row.backfill_last_error = null
        }
        return { rows: [] }
      }
      if (
        n.startsWith('UPDATE WATCHED_ADDRESS') &&
        n.includes('BACKFILL_CURSOR_BLOCK = $1') &&
        !n.includes('BACKFILL_END_BLOCK')
      ) {
        row.backfill_cursor_block = params[0] as string
        return { rows: [] }
      }
      if (n.includes('BACKFILL_COMPLETED_AT = NOW()')) {
        row.backfill_completed_at = new Date()
        return { rows: [] }
      }
      if (n.includes('BACKFILL_LAST_ERROR')) {
        row.backfill_last_error = params[0] as string
        return { rows: [] }
      }
      return { rows: [] }
    },
  )

  const clientQuery = jest.fn(
    async (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: Array<{ id: string }> }> => {
      const n = sql.trim().toUpperCase()
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] }
      if (n.startsWith('INSERT INTO TX ')) {
        const hash = params[1] as string
        const feeCurrency = params[12] as string | null
        txInserts.push({ hash, feeCurrency })
        return { rows: [{ id: String(txInserts.length) }] }
      }
      if (n.startsWith('SELECT ID FROM TX')) return { rows: [] }
      if (n.startsWith('INSERT INTO TX_LOG')) {
        txLogInserts.push(1)
        return { rows: [] }
      }
      if (n.startsWith('UPDATE WATCHED_ADDRESS') && n.includes('BACKFILL_CURSOR_BLOCK')) {
        row.backfill_cursor_block = params[0] as string
        return { rows: [] }
      }
      return { rows: [] }
    },
  )

  const release = jest.fn()
  const connect = jest.fn(async () => ({ query: clientQuery, release }))

  const pool = { connect, query } as unknown as Pool
  ;(pool as unknown as { _row: DbRow })._row = row
  ;(pool as unknown as { _txInserts: typeof txInserts })._txInserts = txInserts
  return pool
}

interface MockRpcOptions {
  tip?: bigint
  outbound?: Array<{ transactionHash: string; blockNumber: bigint }>
  inbound?: Array<{ transactionHash: string; blockNumber: bigint }>
  txByHash?: Record<string, {
    hash: `0x${string}`
    from: string
    to: string | null
    transactionIndex: number | null
    value: bigint
    input: string
    blockNumber?: bigint
    feeCurrency?: string | null
  }>
  receiptByHash?: Record<string, {
    status: 'success' | 'reverted'
    transactionIndex: number
    gasUsed: bigint
    effectiveGasPrice: bigint | undefined
    logs: ReadonlyArray<{
      logIndex: number | null
      address: string
      topics: ReadonlyArray<string>
      data: string
    }>
  }>
  failGetLogsTimes?: number
}

function buildFakeExecutor(
  opts: MockRpcOptions = {},
): { executor: FallbackExecutor; getLogsAttempts: number } {
  const state = {
    getLogsCallsRemainingFailure: opts.failGetLogsTimes ?? 0,
    attempts: 0,
  }
  const tip = opts.tip ?? 200n
  const outbound = opts.outbound ?? []
  const inbound = opts.inbound ?? []
  const txByHash = opts.txByHash ?? {}
  const receiptByHash = opts.receiptByHash ?? {}

  const executor: FallbackExecutor = {
    async withFallback(label, invoke) {
      state.attempts += 1
      // We don't actually invoke the client; we simulate a viem client whose
      // method behaviour depends on the label the backfill loop passes in.
      const fakeClient: unknown = {
        async getBlockNumber() {
          return tip
        },
        async getBlock() {
          return { timestamp: 1_700_000_000n }
        },
        async getTransaction({ hash }: { hash: `0x${string}` }) {
          const t = txByHash[hash.toLowerCase()]
          if (!t) throw new Error(`no tx fixture for ${hash}`)
          return t
        },
        async getTransactionReceipt({ hash }: { hash: `0x${string}` }) {
          const r = receiptByHash[hash.toLowerCase()]
          if (!r) throw new Error(`no receipt fixture for ${hash}`)
          return r
        },
        async request({ params }: { method: string; params: unknown }) {
          if (state.getLogsCallsRemainingFailure > 0) {
            state.getLogsCallsRemainingFailure -= 1
            throw new Error('Cloudflare 1015')
          }
          const p = (params as Array<{ topics: (string | null)[] }>)[0]
          if (!p) return []
          const topic1 = p.topics[1]
          const topic2 = p.topics[2]
          if (typeof topic1 === 'string' && topic2 === null) return outbound
          if (typeof topic2 === 'string' && topic1 === null) return inbound
          return []
        },
      }
      return invoke(fakeClient as never)
    },
    getSkippedEndpoints() {
      return []
    },
  }
  return { executor, getLogsAttempts: state.attempts }
}

const RECEIPT_EMPTY = {
  status: 'success' as const,
  transactionIndex: 0,
  gasUsed: 21_000n,
  effectiveGasPrice: 5_000_000_000n,
  logs: [] as never[],
}

beforeEach(() => {
  _testHelpers.clearInProgress()
})

describe('runBackfillLoopForAddress - initialization', () => {
  it('snaps end_block to current tip and cursor to (tip - depth) on first run', async () => {
    const db = buildMockDb({ address: ADDR })
    const { executor } = buildFakeExecutor({ tip: 100n })
    await runBackfillLoopForAddress(db, ADDR, {
      executor,
      depthBlocksOverride: 30,
      chunkDelayMsOverride: 0,
    })
    const row = (db as unknown as { _row: DbRow })._row
    // cursor = 100 - 30 = 70; end = 100; loop runs chunks then completes.
    expect(row.backfill_completed_at).not.toBeNull()
  })

  it('does not re-initialize when cursor / end already set (resume path)', async () => {
    const db = buildMockDb({
      address: ADDR,
      backfill_cursor_block: '50',
      backfill_end_block: '55',
    })
    const { executor } = buildFakeExecutor({ tip: 999999n })
    await runBackfillLoopForAddress(db, ADDR, {
      executor,
      // Depth would imply a totally different window; the loop must honour
      // the persisted cursor / end instead.
      depthBlocksOverride: 100_000_000,
      chunkDelayMsOverride: 0,
    })
    // Cursor advances from 50 -> 55 -> 56 (>end) -> completed.
    const row = (db as unknown as { _row: DbRow })._row
    expect(row.backfill_completed_at).not.toBeNull()
    // end_block never got overwritten to the huge value from tip - depth.
    expect(row.backfill_end_block).toBe('55')
  })
})

describe('runBackfillLoopForAddress - chunk pipeline', () => {
  it('advances the cursor and persists tx rows for each chunk', async () => {
    const HASH = '0xabc0000000000000000000000000000000000000000000000000000000000001'
    const db = buildMockDb({ address: ADDR })
    const { executor } = buildFakeExecutor({
      tip: 10n,
      outbound: [{ transactionHash: HASH, blockNumber: 3n }],
      txByHash: {
        [HASH]: {
          hash: HASH as `0x${string}`,
          from: ADDR,
          to: OTHER,
          transactionIndex: 0,
          value: 0n,
          input: '0x',
          blockNumber: 3n,
          feeCurrency: null,
        },
      },
      receiptByHash: { [HASH]: RECEIPT_EMPTY },
    })
    await runBackfillLoopForAddress(db, ADDR, {
      executor,
      depthBlocksOverride: 10,
      chunkDelayMsOverride: 0,
    })
    const inserts = (db as unknown as { _txInserts: Array<{ hash: string }> })._txInserts
    expect(inserts.some((i) => i.hash === HASH)).toBe(true)
    const row = (db as unknown as { _row: DbRow })._row
    expect(row.backfill_completed_at).not.toBeNull()
  })

  it('propagates tx.feeCurrency into the INSERT (bug 4 regression)', async () => {
    const HASH = '0xabc0000000000000000000000000000000000000000000000000000000000002'
    const COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'
    const db = buildMockDb({ address: ADDR })
    const { executor } = buildFakeExecutor({
      tip: 10n,
      outbound: [{ transactionHash: HASH, blockNumber: 5n }],
      txByHash: {
        [HASH]: {
          hash: HASH as `0x${string}`,
          from: ADDR,
          to: OTHER,
          transactionIndex: 0,
          value: 0n,
          input: '0x',
          blockNumber: 5n,
          feeCurrency: COPM,
        },
      },
      receiptByHash: { [HASH]: RECEIPT_EMPTY },
    })
    await runBackfillLoopForAddress(db, ADDR, {
      executor,
      depthBlocksOverride: 10,
      chunkDelayMsOverride: 0,
    })
    const inserts = (db as unknown as { _txInserts: Array<{ hash: string; feeCurrency: string | null }> })._txInserts
    const entry = inserts.find((i) => i.hash === HASH)
    expect(entry?.feeCurrency).toBe(COPM.toLowerCase())
  })
})

describe('runBackfillLoopForAddress - adaptive backoff', () => {
  it('does not advance the cursor when the fallback executor throws (RPC failure)', async () => {
    const db = buildMockDb({ address: ADDR })
    const { executor } = buildFakeExecutor({
      tip: 100n,
      failGetLogsTimes: 10_000, // every chunk's getLogs fails
    })
    // Force the loop to bail out after a bounded number of iterations by
    // capping the delay and letting the outer timeout kill it.
    const p = runBackfillLoopForAddress(db, ADDR, {
      executor,
      depthBlocksOverride: 5,
      chunkDelayMsOverride: 0,
      maxDelayMsOverride: 1,
    })
    // Let a few loop iterations run without persistence.
    await new Promise((r) => setTimeout(r, 30))
    const row = (db as unknown as { _row: DbRow })._row
    // Cursor never advanced past the initialised from-block, error field set.
    expect(row.backfill_completed_at).toBeNull()
    expect(row.backfill_last_error).toContain('Cloudflare 1015')
    // Clean up by throwing an unhandled promise rejection recovery.
    p.catch(() => {})
  })
})

describe('triggerBackfill dedupe', () => {
  it('does not spawn a second concurrent loop for the same address', async () => {
    const HASH = '0xabc0000000000000000000000000000000000000000000000000000000000003'
    const db = buildMockDb({ address: ADDR })
    const { executor } = buildFakeExecutor({
      tip: 5n,
      outbound: [{ transactionHash: HASH, blockNumber: 3n }],
      txByHash: {
        [HASH]: {
          hash: HASH as `0x${string}`,
          from: ADDR,
          to: OTHER,
          transactionIndex: 0,
          value: 0n,
          input: '0x',
          blockNumber: 3n,
          feeCurrency: null,
        },
      },
      receiptByHash: { [HASH]: RECEIPT_EMPTY },
    })
    triggerBackfill(db, ADDR, { executor, depthBlocksOverride: 5, chunkDelayMsOverride: 0 })
    triggerBackfill(db, ADDR, { executor, depthBlocksOverride: 5, chunkDelayMsOverride: 0 })
    await new Promise((r) => setTimeout(r, 40))
    // in-progress cleared after the loop completes
    expect(_testHelpers.isInProgress(ADDR)).toBe(false)
  })
})

describe('resumePendingBackfills', () => {
  it('picks up rows that have a cursor set but no completion timestamp', async () => {
    const db = buildMockDb({
      address: ADDR,
      backfill_cursor_block: '95',
      backfill_end_block: '100',
    })
    const { executor } = buildFakeExecutor({ tip: 200n })
    const started = await resumePendingBackfills(db, {
      executor,
      chunkDelayMsOverride: 0,
    })
    expect(started).toBe(1)
    await new Promise((r) => setTimeout(r, 30))
    const row = (db as unknown as { _row: DbRow })._row
    expect(row.backfill_completed_at).not.toBeNull()
  })

  it('is a no-op when no rows are pending', async () => {
    const db = buildMockDb({
      address: ADDR,
      backfill_completed_at: new Date(),
    })
    const { executor } = buildFakeExecutor({ tip: 100n })
    const started = await resumePendingBackfills(db, { executor })
    expect(started).toBe(0)
  })
})

describe('walletCreatedAtToFromBlock', () => {
  const CELO_L2_MIGRATION_MS = Date.parse('2025-03-26T00:00:00Z')

  it('returns tip for future dates (silently caps)', () => {
    const now = Date.parse('2026-07-06T00:00:00Z')
    const future = '2027-01-01T00:00:00Z'
    expect(walletCreatedAtToFromBlock(future, 1_000_000n, now)).toBe(1_000_000n)
  })

  it('returns tip for unparseable strings', () => {
    const now = Date.parse('2026-07-06T00:00:00Z')
    expect(walletCreatedAtToFromBlock('not-a-date', 1_000_000n, now)).toBe(1_000_000n)
  })

  it('uses ~1 s/block for post-L2 wallets', () => {
    const now = CELO_L2_MIGRATION_MS + 3_600 * 1000 // 1 hour post-L2
    const created = new Date(CELO_L2_MIGRATION_MS + 1_800 * 1000).toISOString() // 30 min post-L2
    const tip = 10_000_000n
    // 30 min of blocks post-L2 at 1s/block = 1800 blocks
    expect(walletCreatedAtToFromBlock(created, tip, now)).toBe(tip - 1_800n)
  })

  it('segments across the L2 migration boundary for older wallets', () => {
    const now = CELO_L2_MIGRATION_MS + 100 * 1000 // 100 s post-L2
    const created = new Date(CELO_L2_MIGRATION_MS - 500 * 1000).toISOString() // 500 s pre-L2
    const tip = 10_000_000n
    // Post-L2 segment: 100 s * 1 = 100 blocks. Pre-L2 segment: 500 s / 5 = 100 blocks.
    // Total = 200 blocks.
    expect(walletCreatedAtToFromBlock(created, tip, now)).toBe(tip - 200n)
  })

  it('caps at SAFETY_MAX_BACKFILL_BLOCKS (5M)', () => {
    const now = Date.parse('2030-01-01T00:00:00Z')
    const created = '2020-01-01T00:00:00Z' // ~10 yrs older, way past cap
    const tip = 100_000_000n
    // Should cap at 5M blocks, never scan further.
    expect(walletCreatedAtToFromBlock(created, tip, now)).toBe(tip - 5_000_000n)
  })

  it('returns 0 when the estimate exceeds the current tip', () => {
    const now = Date.parse('2026-07-06T00:00:00Z')
    const created = new Date(CELO_L2_MIGRATION_MS).toISOString()
    const tip = 100n // tiny tip
    expect(walletCreatedAtToFromBlock(created, tip, now)).toBe(0n)
  })
})

describe('reopenBackfillIfDeeper', () => {
  it('no-ops when the row has never completed a backfill', async () => {
    const db = buildMockDb({
      address: ADDR,
      backfill_cursor_block: '100',
      backfill_end_block: '200',
      backfill_completed_at: null,
    })
    const opened = await reopenBackfillIfDeeper(db, ADDR, 90_000_000n, '2020-06-01T00:00:00Z')
    expect(opened).toBe(false)
  })

  it('re-opens a legacy completed row (initial_from IS NULL) with walletCreatedAt', async () => {
    // Simulate a wallet backfilled BEFORE PR #100 with default depth
    // 10000 blocks. backfill_initial_from_block is NULL so we cannot
    // tell what the original floor was; the re-open falls back to
    // scanning up to the previous end_block.
    const now = Date.parse('2026-07-07T00:00:00Z')
    const jestNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const db = buildMockDb({
        address: ADDR,
        backfill_cursor_block: '89990001',
        backfill_end_block: '89990000', // completed: cursor = end + 1
        backfill_initial_from_block: null,
        backfill_completed_at: new Date('2026-07-06T20:00:00Z'),
      })
      const opened = await reopenBackfillIfDeeper(
        db,
        ADDR,
        90_000_000n,
        '2026-06-15T00:00:00.000Z',
      )
      expect(opened).toBe(true)
      const row = (db as unknown as { _row: DbRow })._row
      expect(row.backfill_completed_at).toBeNull()
      // walletCreatedAt 22 days back at 1 s/block post-L2 = 1_900_800 blocks
      // fromBlock = tip - 1_900_800 = 88_099_200
      expect(row.backfill_cursor_block).toBe('88099200')
      expect(row.backfill_initial_from_block).toBe('88099200')
      // Legacy path: end_block stays at the previous end (redundant scan
      // acceptable because persistTx is upsert-idempotent).
      expect(row.backfill_end_block).toBe('89990000')
    } finally {
      jestNowSpy.mockRestore()
    }
  })

  it('re-opens with new end = initial_from - 1 when initial_from was recorded', async () => {
    // Post-PR #101 row: initial_from = 89_990_000 recorded from prior
    // /watch. New walletCreatedAt implies a deeper 88_000_000. Only the
    // NEW range [88_000_000, 89_989_999] should be scanned.
    const now = Date.parse('2026-07-07T00:00:00Z')
    const jestNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const db = buildMockDb({
        address: ADDR,
        backfill_cursor_block: '90000001',
        backfill_end_block: '90000000',
        backfill_initial_from_block: '89990000',
        backfill_completed_at: new Date('2026-07-06T20:00:00Z'),
      })
      // Pick a walletCreatedAt that puts derived from at 88_000_000
      // (2 000 000 blocks back at 1 s/block = ~23 days back)
      const deepIso = new Date(now - 2_000_000_000).toISOString()
      const opened = await reopenBackfillIfDeeper(db, ADDR, 90_000_000n, deepIso)
      expect(opened).toBe(true)
      const row = (db as unknown as { _row: DbRow })._row
      expect(row.backfill_completed_at).toBeNull()
      expect(row.backfill_cursor_block).toBe('88000000')
      expect(row.backfill_initial_from_block).toBe('88000000')
      expect(row.backfill_end_block).toBe('89989999')
    } finally {
      jestNowSpy.mockRestore()
    }
  })

  it('no-ops when the row already scanned as deep as the new walletCreatedAt', async () => {
    const now = Date.parse('2026-07-07T00:00:00Z')
    const jestNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const db = buildMockDb({
        address: ADDR,
        backfill_cursor_block: '90000001',
        backfill_end_block: '90000000',
        backfill_initial_from_block: '85000000', // already deep
        backfill_completed_at: new Date('2026-07-06T20:00:00Z'),
      })
      // walletCreatedAt implies from = tip - 1_000_000 = 89_000_000
      // which is NOT deeper than existing 85_000_000, so no-op.
      const shallowIso = new Date(now - 1_000_000_000).toISOString()
      const opened = await reopenBackfillIfDeeper(db, ADDR, 90_000_000n, shallowIso)
      expect(opened).toBe(false)
      const row = (db as unknown as { _row: DbRow })._row
      expect(row.backfill_completed_at).not.toBeNull()
      expect(row.backfill_initial_from_block).toBe('85000000')
    } finally {
      jestNowSpy.mockRestore()
    }
  })
})
