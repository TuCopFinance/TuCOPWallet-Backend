import { computeTickWindow, HEAD_LAG_BUFFER_BLOCKS, ingestRange, type IndexerRpcClient } from './worker'

const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const WATCHED_1 = '0x1111111111111111111111111111111111111111'
const WATCHED_2 = '0x2222222222222222222222222222222222222222'
const OTHER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function addressTopic(addr: string): string {
  return '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
}

function buildRpc(opts: {
  blockTimestamp: bigint
  transactions: Array<{
    hash: `0x${string}`
    from: string
    to: string | null
    transactionIndex: number
    value: bigint
    input: string
    logs: Array<{
      logIndex: number
      address: string
      topics: string[]
      data: string
    }>
  }>
}): IndexerRpcClient {
  return {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({
      timestamp: opts.blockTimestamp,
      transactions: opts.transactions.map((tx) => ({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        transactionIndex: tx.transactionIndex,
        value: tx.value,
        input: tx.input,
      })),
    }),
    getTransactionReceipt: async ({ hash }) => {
      const tx = opts.transactions.find((t) => t.hash === hash)
      if (!tx) throw new Error(`no fixture for ${hash}`)
      return {
        status: 'success',
        transactionIndex: tx.transactionIndex,
        gasUsed: 21000n,
        effectiveGasPrice: 5_000_000_000n,
        logs: tx.logs.map((l) => ({
          logIndex: l.logIndex,
          address: l.address,
          topics: l.topics,
          data: l.data,
        })),
      }
    },
    // Test stub for the log-first pre-filter. Walks the fixture logs and
    // returns hashes where any of the padded topics appears in the log's
    // topic1 or topic2 slot AND (if a contractAddresses filter is
    // provided) the log's contract address matches one of them. Mirrors
    // production logic so ingestRange filtering behaves the same whether
    // logs come from a real RPC or the fixture set.
    getWatchedLogTxHashes: async ({ paddedTopics, contractAddresses }) => {
      const paddedSet = new Set(paddedTopics.map((t) => t.toLowerCase()))
      const addressSet =
        contractAddresses.length > 0
          ? new Set(contractAddresses.map((a) => a.toLowerCase()))
          : null
      const out = new Set<string>()
      for (const tx of opts.transactions) {
        for (const l of tx.logs) {
          if (addressSet && !addressSet.has(l.address.toLowerCase())) continue
          const t1 = l.topics[1]?.toLowerCase()
          const t2 = l.topics[2]?.toLowerCase()
          if ((t1 && paddedSet.has(t1)) || (t2 && paddedSet.has(t2))) {
            out.add(tx.hash.toLowerCase())
            break
          }
        }
      }
      return out
    },
  }
}

interface RecordedQuery {
  sql: string
  params: readonly unknown[]
}

function buildFakeDb() {
  const queries: RecordedQuery[] = []
  let txIdSeq = 0
  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const normalized = sql.trim().toUpperCase()
      if (normalized.startsWith('INSERT INTO TX ')) {
        txIdSeq += 1
        return { rows: [{ id: String(txIdSeq) }] }
      }
      if (normalized.startsWith('SELECT ID FROM TX')) {
        return { rows: [] }
      }
      return { rows: [] }
    },
    release: jest.fn(),
  }
  const db = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
  }
  return { db, client, queries, getInsertedTxCount: () => txIdSeq }
}

describe('ingestRange', () => {
  it('ingests direct-touch transactions and log-touch receives, skips unrelated tx', async () => {
    const rpc = buildRpc({
      blockTimestamp: 1700000000n,
      transactions: [
        // tx1: WATCHED_1 sends to OTHER_A (direct touch via from)
        {
          hash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
          from: WATCHED_1,
          to: OTHER_A,
          transactionIndex: 0,
          value: 1_000_000n,
          input: '0x',
          logs: [],
        },
        // tx2: OTHER_A transfers ERC20 to WATCHED_2 (log touch via Transfer event)
        {
          hash: '0xaaaa000000000000000000000000000000000000000000000000000000000002',
          from: OTHER_A,
          to: OTHER_B,
          transactionIndex: 1,
          value: 0n,
          input: '0xa9059cbb' + '0'.repeat(56) + WATCHED_2.slice(2),
          logs: [
            {
              logIndex: 0,
              address: OTHER_B,
              topics: [
                ERC20_TRANSFER_TOPIC0,
                addressTopic(OTHER_A),
                addressTopic(WATCHED_2),
              ],
              data: '0x' + '0'.repeat(63) + '1',
            },
          ],
        },
        // tx3: unrelated tx between OTHER_A and OTHER_B, no watched addresses
        {
          hash: '0xaaaa000000000000000000000000000000000000000000000000000000000003',
          from: OTHER_A,
          to: OTHER_B,
          transactionIndex: 2,
          value: 0n,
          input: '0x',
          logs: [
            {
              logIndex: 0,
              address: OTHER_B,
              topics: [
                ERC20_TRANSFER_TOPIC0,
                addressTopic(OTHER_A),
                addressTopic(OTHER_B),
              ],
              data: '0x',
            },
          ],
        },
      ],
    })

    const { db, queries, getInsertedTxCount } = buildFakeDb()
    const watched = new Set([WATCHED_1, WATCHED_2])

    const result = await ingestRange(rpc, db as never, {
      fromBlock: 100n,
      toBlock: 100n,
      watched,
      logContractAddresses: [],
    })

    expect(result.txCount).toBe(2)
    expect(getInsertedTxCount()).toBe(2)

    const insertTxSqls = queries.filter((q) =>
      q.sql.trim().toUpperCase().startsWith('INSERT INTO TX '),
    )
    expect(insertTxSqls).toHaveLength(2)

    const insertLogSqls = queries.filter((q) =>
      q.sql.trim().toUpperCase().startsWith('INSERT INTO TX_LOG'),
    )
    expect(insertLogSqls).toHaveLength(1)

    const beginCount = queries.filter((q) => q.sql.trim().toUpperCase() === 'BEGIN').length
    const commitCount = queries.filter((q) => q.sql.trim().toUpperCase() === 'COMMIT').length
    expect(beginCount).toBe(2)
    expect(commitCount).toBe(2)
  })

  it('returns zero counts when no transactions touch a watched address', async () => {
    const rpc = buildRpc({
      blockTimestamp: 1700000000n,
      transactions: [
        {
          hash: '0xbbbb000000000000000000000000000000000000000000000000000000000001',
          from: OTHER_A,
          to: OTHER_B,
          transactionIndex: 0,
          value: 0n,
          input: '0x',
          logs: [],
        },
      ],
    })

    const { db, queries } = buildFakeDb()

    const result = await ingestRange(rpc, db as never, {
      fromBlock: 100n,
      toBlock: 100n,
      watched: new Set([WATCHED_1]),
      logContractAddresses: [],
    })

    expect(result.txCount).toBe(0)
    expect(queries.filter((q) => q.sql.trim().toUpperCase().startsWith('INSERT')).length).toBe(0)
  })
})

describe('computeTickWindow', () => {
  it('returns null when the reported tip has already caught up to the cursor', () => {
    // tip==last -> nothing new to ingest
    expect(
      computeTickWindow({ tip: 100n, lastProcessed: 100n, maxBlocksPerTick: 500 }),
    ).toBeNull()
  })

  it('returns null when the only unprocessed block is the reported tip itself (head-lag guard)', () => {
    // tip = last + 1. Without the buffer we would query getLogs for a block
    // the next-picked provider may not have seen yet ("block range extends
    // beyond current head block"). The default 1-block buffer collapses this
    // case to null; the next tick catches up once the tip advances.
    expect(
      computeTickWindow({ tip: 101n, lastProcessed: 100n, maxBlocksPerTick: 500 }),
    ).toBeNull()
  })

  it('trails one block behind reported tip when the range is wider than the buffer', () => {
    // tip - buffer = safeTip = 199. from = last + 1. target = safeTip.
    expect(
      computeTickWindow({ tip: 200n, lastProcessed: 100n, maxBlocksPerTick: 500 }),
    ).toEqual({ from: 101n, target: 199n })
  })

  it('caps the target at lastProcessed + maxBlocksPerTick', () => {
    // safeTip = 999 but maxBlocksPerTick = 10, so target is capped at 110.
    expect(
      computeTickWindow({ tip: 1000n, lastProcessed: 100n, maxBlocksPerTick: 10 }),
    ).toEqual({ from: 101n, target: 110n })
  })

  it('honors a custom headLagBuffer of 0 (opt-out for tests that emulate a single-provider environment)', () => {
    // With buffer=0 the previous behavior is preserved (tip is the target).
    expect(
      computeTickWindow({
        tip: 101n,
        lastProcessed: 100n,
        maxBlocksPerTick: 500,
        headLagBuffer: 0n,
      }),
    ).toEqual({ from: 101n, target: 101n })
  })

  it('exports the default buffer as 1n (guards against silent widening of the lag)', () => {
    expect(HEAD_LAG_BUFFER_BLOCKS).toBe(1n)
  })
})
