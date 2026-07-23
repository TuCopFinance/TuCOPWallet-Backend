import { encodeAbiParameters, pad, toHex } from 'viem'
import {
  CONTRACT_ADDRESS,
  EVENT_A_TOPIC0,
  EVENT_B_TOPIC0,
  EVENT_C_TOPIC0,
  EVENT_D_TOPIC0,
} from './abi'
import type { NeeruGetLogsArgs, NeeruIndexerRpcClient, NeeruLog } from './rpc'
import type {
  KindAArgs,
  KindBArgs,
  KindCArgs,
  KindDArgs,
  NeeruOnchainBatchContext,
} from './types'
import {
  chunkBlockRange,
  dispatchNeeruEvent,
  handleKindA,
  handleKindB,
  handleKindC,
  handleKindD,
  parseNeeruLog,
  runTick,
} from './worker'

interface RecordedQuery {
  sql: string
  params: readonly unknown[]
}

function buildFakeDb(opts: {
  lastScannedBlock: bigint
  clientQueryImpl?: (
    sql: string,
    params: readonly unknown[],
  ) => Promise<{ rows: readonly unknown[]; rowCount?: number }> | null
}) {
  const queries: RecordedQuery[] = []
  const counters = { begin: 0, commit: 0, rollback: 0, release: 0 }
  const stateRow = {
    id: 1,
    last_scanned_block: opts.lastScannedBlock.toString(),
    last_scan_at: new Date('2026-06-26T00:00:00Z'),
    last_error: null,
    last_error_at: null,
  }
  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const normalised = sql.trim().toUpperCase()
      if (normalised === 'BEGIN') {
        counters.begin += 1
        return { rows: [] }
      }
      if (normalised === 'COMMIT') {
        counters.commit += 1
        return { rows: [] }
      }
      if (normalised === 'ROLLBACK') {
        counters.rollback += 1
        return { rows: [] }
      }
      if (opts.clientQueryImpl) {
        const override = opts.clientQueryImpl(sql, params)
        if (override) return override
      }
      return { rows: [], rowCount: 1 }
    },
    release: () => {
      counters.release += 1
    },
  }
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return { rows: [stateRow] }
      }
      return { rows: [] }
    },
    connect: async () => client,
  }
  return { db, client, queries, counters }
}

function buildRpc(opts: {
  latestBlock: bigint
  logsByBatch?: NeeruLog[][]
  multicallImpl?: (args: unknown) => Promise<unknown>
  getBlockImpl?: (args: { blockNumber: bigint }) => Promise<{
    number: bigint
    timestamp: bigint
  }>
}): {
  rpc: NeeruIndexerRpcClient
  getLogsCalls: NeeruGetLogsArgs[]
  multicallCalls: unknown[]
  getBlockCalls: { blockNumber: bigint }[]
} {
  const getLogsCalls: NeeruGetLogsArgs[] = []
  const multicallCalls: unknown[] = []
  const getBlockCalls: { blockNumber: bigint }[] = []
  const batches = opts.logsByBatch ?? []
  const rpc: NeeruIndexerRpcClient = {
    getBlockNumber: async () => opts.latestBlock,
    getBlock: async (args) => {
      getBlockCalls.push(args)
      if (opts.getBlockImpl) return opts.getBlockImpl(args)
      return { number: args.blockNumber, timestamp: 1_700_000_000n }
    },
    getLogs: async (args) => {
      const idx = getLogsCalls.length
      getLogsCalls.push(args)
      return batches[idx] ?? []
    },
    multicall: (async (args: unknown) => {
      multicallCalls.push(args)
      if (opts.multicallImpl) return opts.multicallImpl(args)
      return []
    }) as never,
    readContract: (async () => {
      throw new Error('readContract not used here')
    }) as never,
    call: (async () => {
      throw new Error('call not used here')
    }) as never,
  }
  return { rpc, getLogsCalls, multicallCalls, getBlockCalls }
}

const ADDR_USER = '0x1111111111111111111111111111111111111111'
// Synthetic test address. The prior `0xa203bb...` prefix matched a real
// maintainer wallet; the obvious `0x3333...` repeating pattern is unambiguous.
const ADDR_USER_2 = '0x3333333333333333333333333333333333333333'

function padAddress(a: string): `0x${string}` {
  return pad(a as `0x${string}`, { size: 32 })
}
function padUint(n: bigint): `0x${string}` {
  return pad(toHex(n), { size: 32 })
}

function buildLogA(args: {
  user: string
  id: bigint
  category: number
  amount: bigint
  endTs: bigint
  blockNumber: bigint
  txHash: string
  logIndex: number
}): NeeruLog {
  const data = encodeAbiParameters(
    [
      { type: 'uint8' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
    [args.category, args.amount, 0n, args.endTs],
  )
  return {
    address: CONTRACT_ADDRESS,
    blockNumber: args.blockNumber,
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: args.txHash,
    transactionIndex: 0,
    logIndex: args.logIndex,
    topics: [EVENT_A_TOPIC0, padAddress(args.user), padUint(args.id)],
    data,
    removed: false,
  }
}

function buildLogB(args: {
  user: string
  id: bigint
  blockNumber: bigint
  txHash: string
  logIndex: number
}): NeeruLog {
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }],
    [0n, 0n],
  )
  return {
    address: CONTRACT_ADDRESS,
    blockNumber: args.blockNumber,
    blockHash: '0x' + '22'.repeat(32),
    transactionHash: args.txHash,
    transactionIndex: 0,
    logIndex: args.logIndex,
    topics: [EVENT_B_TOPIC0, padAddress(args.user), padUint(args.id)],
    data,
    removed: false,
  }
}

function buildLogC(args: {
  user: string
  id: bigint
  blockNumber: bigint
  txHash: string
  logIndex: number
}): NeeruLog {
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }],
    [0n, 0n],
  )
  return {
    address: CONTRACT_ADDRESS,
    blockNumber: args.blockNumber,
    blockHash: '0x' + '33'.repeat(32),
    transactionHash: args.txHash,
    transactionIndex: 0,
    logIndex: args.logIndex,
    topics: [EVENT_C_TOPIC0, padAddress(args.user), padUint(args.id)],
    data,
    removed: false,
  }
}

function buildLogD(args: {
  user: string
  oldId: bigint
  newId: bigint
  newAmount: bigint
  endTs: bigint
  blockNumber: bigint
  txHash: string
  logIndex: number
}): NeeruLog {
  const data = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
    [args.newAmount, 0n, 0n, args.endTs],
  )
  return {
    address: CONTRACT_ADDRESS,
    blockNumber: args.blockNumber,
    blockHash: '0x' + '44'.repeat(32),
    transactionHash: args.txHash,
    transactionIndex: 0,
    logIndex: args.logIndex,
    topics: [
      EVENT_D_TOPIC0,
      padAddress(args.user),
      padUint(args.oldId),
      padUint(args.newId),
    ],
    data,
    removed: false,
  }
}

describe('chunkBlockRange', () => {
  it('returns a single batch when range fits in MAX_BLOCKS_PER_BATCH', () => {
    expect(chunkBlockRange(1n, 5_000n)).toEqual([
      { fromBlock: 1n, toBlock: 5_000n },
    ])
  })

  it('splits a range larger than MAX_BLOCKS_PER_BATCH into capped batches', () => {
    expect(chunkBlockRange(1n, 12_000n)).toEqual([
      { fromBlock: 1n, toBlock: 5_000n },
      { fromBlock: 5_001n, toBlock: 10_000n },
      { fromBlock: 10_001n, toBlock: 12_000n },
    ])
  })

  it('returns empty when from > to', () => {
    expect(chunkBlockRange(10n, 5n)).toEqual([])
  })
})

describe('runTick', () => {
  it('applies the 5-block reorg buffer and skips when nothing new', async () => {
    const { db, queries } = buildFakeDb({ lastScannedBlock: 100n })
    const { rpc, getLogsCalls } = buildRpc({ latestBlock: 103n })
    const result = await runTick({ db: db as never, rpc })
    expect(result.scanned).toBe(false)
    expect(getLogsCalls).toHaveLength(0)
    expect(
      queries.filter((q) => q.sql.trim().toUpperCase() === 'BEGIN').length,
    ).toBe(0)
  })

  it('chunks a range larger than MAX_BLOCKS_PER_BATCH into multiple getLogs batches and opens one tx per batch', async () => {
    const { db, queries } = buildFakeDb({ lastScannedBlock: 1_234_567n })
    const { rpc, getLogsCalls } = buildRpc({
      latestBlock: 1_254_578n,
      logsByBatch: [[], [], [], [], []],
    })
    const result = await runTick({ db: db as never, rpc })
    expect(result.scanned).toBe(true)
    expect(result.fromBlock).toBe(1_234_568n)
    expect(result.toBlock).toBe(1_254_573n)
    expect(getLogsCalls).toHaveLength(5)
    for (const call of getLogsCalls) {
      expect((call.address as string).toLowerCase()).toBe(
        CONTRACT_ADDRESS.toLowerCase(),
      )
    }
    const begins = queries.filter(
      (q) => q.sql.trim().toUpperCase() === 'BEGIN',
    ).length
    const commits = queries.filter(
      (q) => q.sql.trim().toUpperCase() === 'COMMIT',
    ).length
    expect(begins).toBe(5)
    expect(commits).toBe(5)
  })

  it('throws when neeru_indexer_state row is missing', async () => {
    const noStateDb = {
      query: async () => ({ rows: [] }),
      connect: async () => {
        throw new Error('not used')
      },
    }
    const { rpc } = buildRpc({ latestBlock: 1000n })
    await expect(runTick({ db: noStateDb as never, rpc })).rejects.toThrow(
      /neeru_indexer_state row missing/,
    )
  })

  it('processes a kind-a log end-to-end and INSERTs in a transaction', async () => {
    const id = 42n
    const txHash = '0x' + 'ab'.repeat(32)
    const blockTs = 1_700_000_000n
    const endTs = 1_702_592_000n

    const log = buildLogA({
      user: ADDR_USER,
      id,
      category: 1,
      amount: 10_000n * 10n ** 18n,
      endTs,
      blockNumber: 1_234_568n,
      txHash,
      logIndex: 0,
    })

    const { db, queries, counters } = buildFakeDb({
      lastScannedBlock: 1_234_567n,
    })
    const { rpc, multicallCalls, getBlockCalls } = buildRpc({
      latestBlock: 1_234_578n,
      logsByBatch: [[log]],
      getBlockImpl: async () => ({ number: 1_234_568n, timestamp: blockTs }),
    })

    const result = await runTick({ db: db as never, rpc })
    expect(result.scanned).toBe(true)
    expect(counters.begin).toBe(1)
    expect(counters.commit).toBe(1)
    expect(counters.rollback).toBe(0)
    expect(multicallCalls).toHaveLength(0)
    expect(getBlockCalls).toHaveLength(1)

    const insert = queries.find((q) =>
      q.sql.trim().toUpperCase().startsWith('INSERT INTO NEERU_POSITIONS'),
    )
    expect(insert).toBeDefined()
    expect(insert?.params).toEqual([
      '42',
      ADDR_USER,
      1,
      (10_000n * 10n ** 18n).toString(),
      blockTs.toString(),
      endTs.toString(),
      '1234568',
      txHash,
    ])
  })
})

describe('parseNeeruLog', () => {
  it('parses a kind-a log into typed args', () => {
    const txHash = '0x' + 'cd'.repeat(32)
    const id = 12345678901234567890n
    const log = buildLogA({
      user: ADDR_USER,
      id,
      category: 2,
      amount: 50_000n * 10n ** 18n,
      endTs: 1_705_184_000n,
      blockNumber: 1_300_000n,
      txHash,
      logIndex: 3,
    })
    const parsed = parseNeeruLog(log)
    expect(parsed.kind).toBe('a')
    if (parsed.kind !== 'a') throw new Error('narrow')
    expect(parsed.user).toBe(ADDR_USER)
    expect(parsed.id).toBe(id)
    expect(parsed.category).toBe(2)
    expect(parsed.amount).toBe(50_000n * 10n ** 18n)
    expect(parsed.endTs).toBe(1_705_184_000n)
    expect(parsed.txHash).toBe(txHash)
    expect(parsed.logIndex).toBe(3)
  })

  it('parses a kind-d log preserving full ids (no truncation)', () => {
    const txHash = '0x' + 'ef'.repeat(32)
    const oldId =
      99999999999999999999999999999999999999999999999999999999999999999999999n
    const newId =
      88888888888888888888888888888888888888888888888888888888888888888888888n
    const log = buildLogD({
      user: ADDR_USER,
      oldId,
      newId,
      newAmount: 12_345n * 10n ** 18n,
      endTs: 1_710_000_000n,
      blockNumber: 1_400_000n,
      txHash,
      logIndex: 5,
    })
    const parsed = parseNeeruLog(log)
    if (parsed.kind !== 'd') throw new Error('narrow')
    expect(parsed.oldId).toBe(oldId)
    expect(parsed.newId).toBe(newId)
    expect(parsed.txHash).toBe(txHash)
  })

  it('parses a kind-b log into typed args', () => {
    const txHash = '0x' + '7a'.repeat(32)
    const log = buildLogB({
      user: ADDR_USER,
      id: 7n,
      blockNumber: 1_300_007n,
      txHash,
      logIndex: 1,
    })
    const parsed = parseNeeruLog(log)
    if (parsed.kind !== 'b') throw new Error('narrow')
    expect(parsed.id).toBe(7n)
    expect(parsed.txHash).toBe(txHash)
  })

  it('parses a kind-c log into typed args', () => {
    const txHash = '0x' + '7b'.repeat(32)
    const log = buildLogC({
      user: ADDR_USER,
      id: 8n,
      blockNumber: 1_300_008n,
      txHash,
      logIndex: 2,
    })
    const parsed = parseNeeruLog(log)
    if (parsed.kind !== 'c') throw new Error('narrow')
    expect(parsed.id).toBe(8n)
    expect(parsed.txHash).toBe(txHash)
  })

  it('throws for an unknown topic0', () => {
    const unknownTopic = `0x${'ff'.repeat(32)}`
    expect(() =>
      parseNeeruLog({
        address: CONTRACT_ADDRESS,
        blockNumber: 1n,
        blockHash: '0x' + '00'.repeat(32),
        transactionHash: '0x' + '00'.repeat(32),
        transactionIndex: 0,
        logIndex: 0,
        topics: [unknownTopic],
        data: '0x',
        removed: false,
      }),
    ).toThrow(/unexpected topic0/)
  })
})

function stubClient(opts: {
  selectRows?: readonly unknown[]
  throwOnInsert?: Error
} = {}) {
  const queries: RecordedQuery[] = []
  return {
    queries,
    client: {
      query: async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params })
        const normalised = sql.trim().toUpperCase()
        if (normalised.startsWith('SELECT')) {
          return {
            rows: opts.selectRows ?? [],
            rowCount: opts.selectRows?.length ?? 0,
          }
        }
        if (normalised.startsWith('INSERT') && opts.throwOnInsert) {
          throw opts.throwOnInsert
        }
        if (normalised.startsWith('UPDATE')) {
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      },
      release: () => {},
    },
  }
}

describe('handleKindA', () => {
  it('INSERTs a row with start_ts = blockTimestamp', async () => {
    const { client, queries } = stubClient()
    const args: KindAArgs = {
      kind: 'a',
      blockNumber: 1_234_568n,
      blockTimestamp: 1_700_000_000n,
      txHash: '0x' + 'aa'.repeat(32),
      logIndex: 0,
      user: ADDR_USER,
      id: 100n,
      category: 3,
      amount: 25_000n * 10n ** 18n,
      endTs: 1_707_776_000n,
    }
    await handleKindA(client as never, args)
    const insert = queries[0]
    expect(insert).toBeDefined()
    expect(insert?.sql).toMatch(/INSERT INTO neeru_positions/i)
    expect(insert?.params).toEqual([
      '100',
      ADDR_USER,
      3,
      (25_000n * 10n ** 18n).toString(),
      '1700000000',
      '1707776000',
      '1234568',
      '0x' + 'aa'.repeat(32),
    ])
  })
})

describe('handleKindB', () => {
  it('marks the row closed and fills closed_* fields', async () => {
    const { client, queries } = stubClient()
    const args: KindBArgs = {
      kind: 'b',
      blockNumber: 1_300_000n,
      blockTimestamp: 1_701_000_000n,
      txHash: '0x' + 'bb'.repeat(32),
      logIndex: 1,
      user: ADDR_USER,
      id: 100n,
    }
    await handleKindB(client as never, args)
    const update = queries[0]
    expect(update?.sql).toMatch(/UPDATE neeru_positions/i)
    expect(update?.sql).toMatch(/SET closed = TRUE/i)
    expect(update?.params).toEqual([
      '100',
      '1701000000',
      '1300000',
      '0x' + 'bb'.repeat(32),
    ])
  })
})

describe('handleKindC', () => {
  it('marks the row closed with the same shape as kind-b', async () => {
    const { client, queries } = stubClient()
    const args: KindCArgs = {
      kind: 'c',
      blockNumber: 1_300_001n,
      blockTimestamp: 1_701_000_001n,
      txHash: '0x' + 'cc'.repeat(32),
      logIndex: 2,
      user: ADDR_USER,
      id: 101n,
    }
    await handleKindC(client as never, args)
    const update = queries[0]
    expect(update?.sql).toMatch(/UPDATE neeru_positions/i)
    expect(update?.sql).toMatch(/SET closed = TRUE/i)
    expect(update?.params).toEqual([
      '101',
      '1701000001',
      '1300001',
      '0x' + 'cc'.repeat(32),
    ])
  })
})

describe('handleKindD', () => {
  const oldId = 200n
  const newId = 201n
  const txHash = '0x' + 'dd'.repeat(32)
  const newAmount = 12_345n * 10n ** 18n
  const endTs = 1_705_000_000n
  const blockTimestamp = 1_702_592_000n
  // Synthetic per-category window used only to exercise the fallback
  // branch below. Value is not a real contract value; see the memory
  // `feedback_cero_exposicion_neeru` for the naming bar.
  const secondaryCatWindowSecs = 14n * 86_400n
  const reconstructedStartTs = endTs - secondaryCatWindowSecs

  function makeArgs(): KindDArgs {
    return {
      kind: 'd',
      blockNumber: 1_350_000n,
      blockTimestamp,
      txHash,
      logIndex: 4,
      user: ADDR_USER,
      oldId,
      newId,
      newAmount,
      endTs,
    }
  }

  function makeCtx(): NeeruOnchainBatchContext {
    return {
      positionCategory: new Map([[newId.toString(), 1]]),
      blockTimestamps: new Map([['1350000', blockTimestamp]]),
      secsByCategory: new Map([[1, secondaryCatWindowSecs]]),
    }
  }

  it('marks the old row closed and inserts a new row with reconstructed startTs', async () => {
    const { client, queries } = stubClient()
    await handleKindD(client as never, makeArgs(), makeCtx())

    expect(queries[0]?.sql).toMatch(/UPDATE neeru_positions/i)
    expect(queries[0]?.sql).toMatch(/SET closed = TRUE/i)
    expect(queries[0]?.params).toEqual([
      '200',
      blockTimestamp.toString(),
      '1350000',
      txHash,
    ])

    expect(queries[1]?.sql).toMatch(/INSERT INTO neeru_positions/i)
    expect(queries[1]?.params).toEqual([
      '201',
      ADDR_USER,
      1,
      newAmount.toString(),
      reconstructedStartTs.toString(),
      endTs.toString(),
      '1350000',
      txHash,
    ])
  })

  it('falls back to blockTimestamp when secs is missing for the category', async () => {
    const { client, queries } = stubClient()
    const ctxWithoutLock: NeeruOnchainBatchContext = {
      positionCategory: new Map([[newId.toString(), 1]]),
      blockTimestamps: new Map([['1350000', blockTimestamp]]),
      secsByCategory: new Map(),
    }
    await handleKindD(client as never, makeArgs(), ctxWithoutLock)

    expect(queries[1]?.sql).toMatch(/INSERT INTO neeru_positions/i)
    expect(queries[1]?.params?.[4]).toEqual(blockTimestamp.toString())
  })

  it('falls back to blockTimestamp when secs is zero (flexible category)', async () => {
    const { client, queries } = stubClient()
    const ctxFlex: NeeruOnchainBatchContext = {
      positionCategory: new Map([[newId.toString(), 0]]),
      blockTimestamps: new Map([['1350000', blockTimestamp]]),
      secsByCategory: new Map([[0, 0n]]),
    }
    await handleKindD(client as never, makeArgs(), ctxFlex)

    expect(queries[1]?.params?.[4]).toEqual(blockTimestamp.toString())
  })

  it('throws when the pre-fetched category is missing', async () => {
    const { client } = stubClient()
    const emptyCtx: NeeruOnchainBatchContext = {
      positionCategory: new Map(),
      blockTimestamps: new Map([['1350000', blockTimestamp]]),
      secsByCategory: new Map(),
    }
    await expect(
      handleKindD(client as never, makeArgs(), emptyCtx),
    ).rejects.toThrow(/missing or invalid pre-fetched category/)
  })
})

describe('runTick atomicity', () => {
  it('rolls back the whole batch if an INSERT throws', async () => {
    const txHash = '0x' + '55'.repeat(32)
    const log = buildLogD({
      user: ADDR_USER_2,
      oldId: 300n,
      newId: 301n,
      newAmount: 1n,
      endTs: 1_705_000_000n,
      blockNumber: 1_400_000n,
      txHash,
      logIndex: 0,
    })

    let insertCount = 0
    const { db, counters } = buildFakeDb({
      lastScannedBlock: 1_399_999n,
      clientQueryImpl: (sql) => {
        const normalised = sql.trim().toUpperCase()
        if (normalised.startsWith('INSERT INTO NEERU_POSITIONS')) {
          insertCount += 1
          throw new Error('simulated unique_violation')
        }
        return null
      },
    })

    const positionsTuple = [ADDR_USER_2, 1, false, 0n, 0n, 0n, 0n, 0n]
    const { rpc } = buildRpc({
      latestBlock: 1_400_010n,
      logsByBatch: [[log]],
      multicallImpl: async () => [positionsTuple],
    })

    await expect(runTick({ db: db as never, rpc })).rejects.toThrow(
      /simulated unique_violation/,
    )

    expect(counters.begin).toBe(1)
    expect(counters.commit).toBe(0)
    expect(counters.rollback).toBe(1)
    expect(insertCount).toBe(1)
  })
})

describe('dispatchNeeruEvent', () => {
  it('routes kind a to handleKindA', async () => {
    const { client, queries } = stubClient()
    const ctx: NeeruOnchainBatchContext = {
      positionCategory: new Map(),
      blockTimestamps: new Map(),
      secsByCategory: new Map(),
    }
    await dispatchNeeruEvent(
      client as never,
      {
        kind: 'a',
        blockNumber: 1n,
        blockTimestamp: 0n,
        txHash: '0x' + '01'.repeat(32),
        logIndex: 0,
        user: ADDR_USER,
        id: 1n,
        category: 1,
        amount: 1n,
        endTs: 1n,
      },
      ctx,
    )
    expect(queries[0]?.sql).toMatch(/INSERT INTO neeru_positions/i)
  })
})
