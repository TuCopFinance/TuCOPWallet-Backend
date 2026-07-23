import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import {
  _resetHooksApiNeeruDetailCacheForTests,
  getNeeruPositionDetail,
} from './detail'

const USER = '0x1111111111111111111111111111111111111111'
const TX_HASH_1 =
  '0x1111111111111111111111111111111111111111111111111111111111111111'
const TX_HASH_2 =
  '0x2222222222222222222222222222222222222222222222222222222222222222'
const TX_HASH_3 =
  '0x3333333333333333333333333333333333333333333333333333333333333333'

const TOKEN_DECIMALS = 18
const RAY = 10n ** 27n

interface CallSpec {
  functionName: string
  args: readonly unknown[]
}

interface FakeRpcOpts {
  decimals?: number
  penaltyBps?: bigint
  secsByCategory?: Map<number, bigint>
  accruedByPositionId?: Map<string, bigint>
  rateByPositionId?: Map<string, bigint>
  failAccruedFor?: Set<string>
  failPositionsFor?: Set<string>
}

function buildFakeRpc(opts: FakeRpcOpts = {}): {
  rpc: NeeruIndexerRpcClient
  callsLog: { contracts: ReadonlyArray<CallSpec> }[]
} {
  const callsLog: { contracts: ReadonlyArray<CallSpec> }[] = []
  const decimals = opts.decimals ?? TOKEN_DECIMALS
  const penaltyBps = opts.penaltyBps ?? 2000n
  const secsMap = opts.secsByCategory ?? new Map<number, bigint>()
  const accruedMap = opts.accruedByPositionId ?? new Map<string, bigint>()
  const rateMap = opts.rateByPositionId ?? new Map<string, bigint>()
  const failAccrued = opts.failAccruedFor ?? new Set<string>()
  const failPositions = opts.failPositionsFor ?? new Set<string>()

  const rpc: NeeruIndexerRpcClient = {
    getBlockNumber: async () => 1n,
    getBlock: async () => ({ number: 1n, timestamp: 0n }),
    getLogs: async () => [],
    multicall: (async (args: {
      contracts: ReadonlyArray<CallSpec>
      allowFailure: boolean
    }) => {
      callsLog.push({ contracts: args.contracts })
      return args.contracts.map((call) => {
        if (call.functionName === 'previewAccruedInterest') {
          const id = (call.args[0] as bigint).toString()
          if (failAccrued.has(id)) {
            return { status: 'failure', error: new Error('rpc fail') }
          }
          return {
            status: 'success',
            result: accruedMap.get(id) ?? 0n,
          }
        }
        if (call.functionName === 'tranches') {
          const c = call.args[0] as number
          const lock = secsMap.get(c) ?? 0n
          // category-read tuple: [r0, r1, r2, r3]; assembler only reads r1.
          return {
            status: 'success',
            result: [0n, lock, 0n, 0n] as readonly bigint[],
          }
        }
        if (call.functionName === 'positions') {
          const id = (call.args[0] as bigint).toString()
          if (failPositions.has(id)) {
            return { status: 'failure', error: new Error('rpc fail') }
          }
          // positions tuple: r0=address, r1=u8, r2=bool, r3..r6=u256,
          // r7=u256 (per-position frozen rate, ray-scaled).
          const r7 = rateMap.get(id) ?? RAY
          return {
            status: 'success',
            result: [
              '0x0000000000000000000000000000000000000000',
              0,
              false,
              0n,
              0n,
              0n,
              0n,
              r7,
            ] as readonly unknown[],
          }
        }
        if (call.functionName === 'earlyClaimPenaltyBps') {
          return { status: 'success', result: penaltyBps }
        }
        if (call.functionName === 'decimals') {
          return { status: 'success', result: decimals }
        }
        return { status: 'failure', error: new Error('unexpected call') }
      })
    }) as never,
    readContract: (async () => {
      throw new Error('readContract not used in detail assembler')
    }) as never,
    call: (async () => {
      throw new Error('call not used in detail assembler')
    }) as never,
  }
  return { rpc, callsLog }
}

interface FakeRow {
  position_id: string
  category: number
  amount: string
  start_ts: string
  end_ts: string
  deposit_block: string
  deposit_tx_hash: string
}

function buildFakeDb(opts: {
  rows: ReadonlyArray<FakeRow>
  lastScannedBlock?: string
  lastScanAt?: Date | null
}) {
  const queries: { sql: string; params: readonly unknown[] }[] = []
  const db = {
    query: jest.fn(async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.includes('FROM neeru_positions')) {
        return { rows: opts.rows, rowCount: opts.rows.length }
      }
      if (sql.includes('FROM neeru_indexer_state')) {
        if (opts.lastScannedBlock === undefined) {
          return { rows: [], rowCount: 0 }
        }
        return {
          rows: [
            {
              id: 1,
              last_scanned_block: opts.lastScannedBlock,
              last_scan_at: opts.lastScanAt ?? new Date('2026-06-26T15:30:00Z'),
              last_error: null,
              last_error_at: null,
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  return { db, queries }
}

describe('getNeeruPositionDetail', () => {
  beforeEach(() => {
    _resetHooksApiNeeruDetailCacheForTests()
  })

  it('returns an empty positions array when the user has no open rows', async () => {
    const { rpc, callsLog } = buildFakeRpc()
    const { db } = buildFakeDb({
      rows: [],
      lastScannedBlock: '1350000',
      lastScanAt: new Date('2026-06-26T15:30:00Z'),
    })

    const res = await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
    })

    expect(res.address).toBe(USER)
    expect(res.positions).toEqual([])
    expect(res.lastSyncedBlock).toBe(1350000)
    expect(res.lastSyncedAt).toBe('2026-06-26T15:30:00.000Z')
    expect(callsLog).toHaveLength(0)
  })

  it('returns null lastSynced fields when the indexer state row is missing', async () => {
    const { rpc } = buildFakeRpc()
    const { db } = buildFakeDb({ rows: [] })

    const res = await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
    })

    expect(res.positions).toEqual([])
    expect(res.lastSyncedBlock).toBeNull()
    expect(res.lastSyncedAt).toBeNull()
  })

  it('builds a single flexible-category position (isEarly=false, no penalty)', async () => {
    const { rpc, callsLog } = buildFakeRpc({
      penaltyBps: 2000n,
      secsByCategory: new Map([[0, 0n]]),
      accruedByPositionId: new Map([['100', 82_500_000_000_000_000_000n]]),
      rateByPositionId: new Map([
        ['100', BigInt(Math.round(1e27 * 1.0001))],
      ]),
    })
    const { db } = buildFakeDb({
      rows: [
        {
          position_id: '100',
          category: 0,
          amount: (10_000n * 10n ** 18n).toString(),
          start_ts: '1700000000',
          end_ts: '1700000000',
          deposit_block: '1234569',
          deposit_tx_hash: TX_HASH_1,
        },
      ],
      lastScannedBlock: '1350000',
    })

    const res = await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
      now: () => 1_900_000_000_000,
      nowSeconds: () => 1_900_000_000,
    })

    expect(res.positions).toHaveLength(1)
    const p = res.positions[0]!
    expect(p.positionId).toBe('100')
    expect(p.category).toBe(0)
    expect(p.categoryLabel).toBe('Flexible')
    expect(p.amount).toBe('10000')
    expect(p.accruedInterest).toBe('82.5')
    expect(p.startTs).toBe(1700000000)
    expect(p.endTs).toBe(1700000000)
    expect(p.depositBlock).toBe(1234569)
    expect(p.depositTxHash).toBe(TX_HASH_1)
    expect(p.renewedFromPositionId).toBeNull()
    const monthly = ((1.0001) ** 30 - 1) * 100
    expect(p.monthlyRatePercentage).toBeCloseTo(monthly, 6)

    // Flexible category -> never early -> interestAfterPenalty == accrued.
    expect(p.currentPayoutIfClosed.isEarly).toBe(false)
    expect(p.currentPayoutIfClosed.penaltyBps).toBe(2000)
    expect(p.currentPayoutIfClosed.amount).toBe('10000')
    expect(p.currentPayoutIfClosed.interest).toBe('82.5')
    expect(p.currentPayoutIfClosed.interestAfterPenalty).toBe('82.5')
    expect(p.currentPayoutIfClosed.total).toBe('10082.5')

    // One single multicall batch issued.
    expect(callsLog).toHaveLength(1)
  })

  it('handles multi-position multi-category with mixed isEarly branches', async () => {
    const secsMap = new Map<number, bigint>([
      [0, 0n],
      [1, BigInt(7 * 86_400)],
      [2, BigInt(21 * 86_400)],
    ])
    const accruedMap = new Map<string, bigint>([
      ['100', 50n * 10n ** 18n],
      ['200', 100n * 10n ** 18n],
      ['201', 40n * 10n ** 18n],
      ['300', 25n * 10n ** 18n],
    ])
    const rateMap = new Map<string, bigint>([
      ['100', BigInt(Math.round(1e27 * 1.0001))],
      ['200', BigInt(Math.round(1e27 * 1.0003))],
      ['201', BigInt(Math.round(1e27 * 1.0003))],
      ['300', BigInt(Math.round(1e27 * 1.0005))],
    ])
    const { rpc, callsLog } = buildFakeRpc({
      penaltyBps: 2000n,
      secsByCategory: secsMap,
      accruedByPositionId: accruedMap,
      rateByPositionId: rateMap,
    })
    const { db } = buildFakeDb({
      rows: [
        // Flex - never early
        {
          position_id: '100',
          category: 0,
          amount: (1_000n * 10n ** 18n).toString(),
          start_ts: '1700000000',
          end_ts: '1700000000',
          deposit_block: '1300001',
          deposit_tx_hash: TX_HASH_1,
        },
        // 30d locked, endTs in the future -> isEarly=true
        {
          position_id: '200',
          category: 1,
          amount: (2_000n * 10n ** 18n).toString(),
          start_ts: '1700000000',
          end_ts: '1900000000',
          deposit_block: '1300002',
          deposit_tx_hash: TX_HASH_2,
        },
        // 30d locked, endTs in the past -> isEarly=false
        {
          position_id: '201',
          category: 1,
          amount: (3_000n * 10n ** 18n).toString(),
          start_ts: '1700000000',
          end_ts: '1700100000',
          deposit_block: '1300003',
          deposit_tx_hash: TX_HASH_3,
        },
        // 90d locked, endTs == now -> isEarly=false (not strictly <)
        {
          position_id: '300',
          category: 2,
          amount: (5_000n * 10n ** 18n).toString(),
          start_ts: '1700000000',
          end_ts: '1800000000',
          deposit_block: '1300004',
          deposit_tx_hash: TX_HASH_3,
        },
      ],
      lastScannedBlock: '1350000',
    })

    const res = await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
      nowSeconds: () => 1_800_000_000,
    })

    expect(res.positions).toHaveLength(4)
    expect(res.positions.map((p) => p.positionId)).toEqual([
      '100',
      '200',
      '201',
      '300',
    ])

    // Flex
    expect(res.positions[0]!.currentPayoutIfClosed.isEarly).toBe(false)
    expect(res.positions[0]!.currentPayoutIfClosed.interestAfterPenalty).toBe(
      '50',
    )
    expect(res.positions[0]!.currentPayoutIfClosed.total).toBe('1050')
    expect(res.positions[0]!.categoryLabel).toBe('Flexible')

    // 30d, isEarly=true. accrued=100, penalty=2000bps -> after = 80, total = 2080.
    expect(res.positions[1]!.categoryLabel).toBe('7 dias')
    expect(res.positions[1]!.currentPayoutIfClosed.isEarly).toBe(true)
    expect(res.positions[1]!.currentPayoutIfClosed.interestAfterPenalty).toBe(
      '80',
    )
    expect(res.positions[1]!.currentPayoutIfClosed.total).toBe('2080')

    // 30d, matured (endTs in past) -> isEarly=false
    expect(res.positions[2]!.currentPayoutIfClosed.isEarly).toBe(false)
    expect(res.positions[2]!.currentPayoutIfClosed.interestAfterPenalty).toBe(
      '40',
    )
    expect(res.positions[2]!.currentPayoutIfClosed.total).toBe('3040')

    // 90d, endTs == now -> not strictly < endTs -> isEarly=false
    expect(res.positions[3]!.categoryLabel).toBe('21 dias')
    expect(res.positions[3]!.currentPayoutIfClosed.isEarly).toBe(false)
    expect(res.positions[3]!.currentPayoutIfClosed.total).toBe('5025')

    // One batch only, even with 4 positions across 3 distinct categories.
    expect(callsLog).toHaveLength(1)
    // 4 accrued + 3 category reads + 4 positions + 1 penalty + 1 decimals = 13
    expect(callsLog[0]!.contracts).toHaveLength(13)
  })

  it('computes penaltyBps bigint math without floating-point rounding', async () => {
    // accrued = 12345 wei -> 12345 * (10000 - 1234) / 10000 = 10823 (integer
    // floor division). 12345 * 8766 = 108_211_770; 108_211_770 / 10000 = 10821.
    const { rpc } = buildFakeRpc({
      penaltyBps: 1234n,
      secsByCategory: new Map([[1, BigInt(7 * 86_400)]]),
      accruedByPositionId: new Map([['7', 12_345n]]),
      rateByPositionId: new Map([['7', RAY]]),
      decimals: 0,
    })
    const { db } = buildFakeDb({
      rows: [
        {
          position_id: '7',
          category: 1,
          amount: '1000',
          start_ts: '1700000000',
          end_ts: '1900000000',
          deposit_block: '1',
          deposit_tx_hash: TX_HASH_1,
        },
      ],
      lastScannedBlock: '2',
    })

    const res = await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
      nowSeconds: () => 1_800_000_000,
    })

    const p = res.positions[0]!
    expect(p.accruedInterest).toBe('12345')
    expect(p.currentPayoutIfClosed.isEarly).toBe(true)
    // bigint floor: 12345 * 8766 / 10000 = 10821
    expect(p.currentPayoutIfClosed.interestAfterPenalty).toBe('10821')
    expect(p.currentPayoutIfClosed.total).toBe('11821')
  })

  it('defaults accruedInterest to "0" when the multicall entry fails', async () => {
    const { rpc } = buildFakeRpc({
      penaltyBps: 2000n,
      secsByCategory: new Map([[1, BigInt(7 * 86_400)]]),
      accruedByPositionId: new Map([['42', 999n * 10n ** 18n]]),
      rateByPositionId: new Map([
        ['42', BigInt(Math.round(1e27 * 1.0003))],
      ]),
      failAccruedFor: new Set(['42']),
    })
    const { db } = buildFakeDb({
      rows: [
        {
          position_id: '42',
          category: 1,
          amount: (500n * 10n ** 18n).toString(),
          start_ts: '1700000000',
          end_ts: '1900000000',
          deposit_block: '1300001',
          deposit_tx_hash: TX_HASH_1,
        },
      ],
      lastScannedBlock: '1350000',
    })

    const res = await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
      nowSeconds: () => 1_800_000_000,
    })

    const p = res.positions[0]!
    expect(p.accruedInterest).toBe('0')
    expect(p.currentPayoutIfClosed.interest).toBe('0')
    // 500 + 0 * (1 - penalty) = 500
    expect(p.currentPayoutIfClosed.interestAfterPenalty).toBe('0')
    expect(p.currentPayoutIfClosed.total).toBe('500')
  })

  it('caches earlyClaimPenaltyBps and per-category reads across calls within TTL', async () => {
    const { rpc, callsLog } = buildFakeRpc({
      penaltyBps: 2000n,
      secsByCategory: new Map([[1, BigInt(7 * 86_400)]]),
      accruedByPositionId: new Map([['1', 0n]]),
      rateByPositionId: new Map([['1', RAY]]),
    })
    const { db } = buildFakeDb({
      rows: [
        {
          position_id: '1',
          category: 1,
          amount: '1',
          start_ts: '1',
          end_ts: '2',
          deposit_block: '1',
          deposit_tx_hash: TX_HASH_1,
        },
      ],
      lastScannedBlock: '1',
    })

    let nowMs = 1_700_000_000_000
    const now = () => nowMs
    await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
      now,
      nowSeconds: () => Math.floor(nowMs / 1000),
    })
    // First call: 1 accrued + 1 cat read + 1 positions + 1 penalty + 1 decimals
    expect(callsLog[0]!.contracts).toHaveLength(5)

    nowMs += 10_000
    await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
      now,
      nowSeconds: () => Math.floor(nowMs / 1000),
    })
    // Within TTL: cat read + penalty + decimals all cached. Per-user reads
    // remain: 1 accrued + 1 positions = 2.
    expect(callsLog[1]!.contracts).toHaveLength(2)

    nowMs += 30_000
    await getNeeruPositionDetail({
      address: USER,
      db: db as never,
      rpc,
      now,
      nowSeconds: () => Math.floor(nowMs / 1000),
    })
    // Past TTL: cat read + penalty + decimals re-fetched -> 5 again.
    expect(callsLog[2]!.contracts).toHaveLength(5)
  })
})
