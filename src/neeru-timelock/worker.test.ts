process.env.NEERU_TIMELOCK_ADDRESS =
  '0xe8358c9cfa4f7af8acd6ff86e012d828527497bf'
process.env.NEERU_CONTRACT_ADDRESS =
  '0x988af5977201a0e988f2c75ea952532f6beb5082'
process.env.NEERU_TIMELOCK_GENESIS_BLOCK = '1234568'
process.env.NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0 =
  '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca'
process.env.NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0 =
  '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58'
process.env.NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0 =
  '0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'

import { encodeAbiParameters } from 'viem'
import { chunkBlockRange, runTick } from './worker'
import type { RawLog } from './types'

const CONTRACT_ADDRESS = '0x988af5977201a0e988f2c75ea952532f6beb5082'

interface RecordedQuery {
  sql: string
  params: readonly unknown[]
}

interface BuildFakeOpts {
  state?: {
    lastScannedBlock: bigint
  } | null
  tip?: bigint
  logs?: RawLog[]
  blockTimestamp?: bigint
  scheduledExists?: boolean
}

function buildFakes(opts: BuildFakeOpts = {}) {
  const state = opts.state === undefined
    ? { lastScannedBlock: 1234567n }
    : opts.state
  const tip = opts.tip ?? 1234900n
  const logs = opts.logs ?? []
  const blockTimestamp = opts.blockTimestamp ?? 1783260000n
  const scheduledExists = opts.scheduledExists ?? false

  const queries: RecordedQuery[] = []
  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const norm = sql.trim().toUpperCase()
      if (norm.startsWith('SELECT EXISTS')) {
        return { rows: [{ exists: scheduledExists }] }
      }
      return { rows: [] }
    },
    release: jest.fn(),
  }
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const norm = sql.trim().toUpperCase()
      if (norm.startsWith('SELECT ID')) {
        return {
          rows: state
            ? [
                {
                  id: 1,
                  last_scanned_block: state.lastScannedBlock.toString(),
                  last_scan_at: new Date(),
                  last_error: null,
                  last_error_at: null,
                },
              ]
            : [],
        }
      }
      return { rows: [] }
    },
    connect: async () => client,
  }
  const rpc = {
    getBlockNumber: async () => tip,
    getBlock: async () => ({
      number: 1n,
      timestamp: blockTimestamp,
    }),
    getLogs: async () => logs,
    multicall: async () => [],
    readContract: async () => {
      throw new Error('not used in timelock worker')
    },
  }
  return { db, rpc, queries }
}

describe('chunkBlockRange', () => {
  it('returns a single batch when the range fits', () => {
    const batches = chunkBlockRange(1000n, 1499n, 5000n)
    expect(batches).toEqual([{ fromBlock: 1000n, toBlock: 1499n }])
  })

  it('splits into 5k-block batches', () => {
    const batches = chunkBlockRange(0n, 12345n, 5000n)
    expect(batches).toEqual([
      { fromBlock: 0n, toBlock: 4999n },
      { fromBlock: 5000n, toBlock: 9999n },
      { fromBlock: 10000n, toBlock: 12345n },
    ])
  })

  it('returns empty when from > to', () => {
    expect(chunkBlockRange(500n, 100n, 5000n)).toEqual([])
  })
})

describe('runTick', () => {
  it('no-ops when tip is below reorg buffer', async () => {
    const { db, rpc } = buildFakes({ tip: 3n })
    const result = await runTick({ db: db as never, rpc: rpc as never })
    expect(result.scanned).toBe(false)
  })

  it('no-ops when cursor is at or beyond safeTip', async () => {
    const { db, rpc } = buildFakes({
      state: { lastScannedBlock: 1234900n },
      tip: 1234901n,
    })
    const result = await runTick({ db: db as never, rpc: rpc as never })
    expect(result.scanned).toBe(false)
  })

  it('scans an empty block range successfully', async () => {
    const { db, rpc, queries } = buildFakes({
      state: { lastScannedBlock: 1234567n },
      tip: 1234860n,
      logs: [],
    })
    const result = await runTick({ db: db as never, rpc: rpc as never })
    expect(result.scanned).toBe(true)
    expect(result.logCount).toBe(0)
    // Cursor advance query must have run
    const cursorUpdate = queries.find((q) =>
      q.sql.trim().toUpperCase().includes('UPDATE NEERU_TIMELOCK_STATE'),
    )
    expect(cursorUpdate).toBeDefined()
  })

  it('persists a matching scheduled event and advances the cursor', async () => {
    const data = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [
        CONTRACT_ADDRESS as `0x${string}`,
        0n,
        '0x1b2ac00cdeadbeef' as `0x${string}`,
        `0x${'00'.repeat(32)}` as `0x${string}`,
        172800n,
      ],
    )
    const log: RawLog = {
      address:
        '0xe8358c9cfa4f7af8acd6ff86e012d828527497bf' as `0x${string}`,
      topics: [
        '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca' as `0x${string}`,
        ('0x' + 'aa'.repeat(32)) as `0x${string}`,
        `0x${'00'.repeat(32)}` as `0x${string}`,
      ],
      data,
      blockNumber: 1234860n,
      transactionHash: '0x1234' as `0x${string}`,
      logIndex: 0,
    }
    const { db, rpc, queries } = buildFakes({
      state: { lastScannedBlock: 1234567n },
      tip: 1234870n,
      logs: [log],
      blockTimestamp: 1783260000n,
    })
    const result = await runTick({ db: db as never, rpc: rpc as never })
    expect(result.scanned).toBe(true)
    expect(result.logCount).toBe(1)
    const insert = queries.find(
      (q) =>
        q.sql.trim().toUpperCase().includes('INSERT INTO NEERU_UPGRADE_EVENTS') &&
        q.sql.includes("'scheduled'"),
    )
    expect(insert).toBeDefined()
  })

  it('throws when the singleton state row is missing (migration not applied)', async () => {
    const { db, rpc } = buildFakes({ state: null })
    await expect(
      runTick({ db: db as never, rpc: rpc as never }),
    ).rejects.toThrow(/neeru_timelock_state row missing/)
  })
})
