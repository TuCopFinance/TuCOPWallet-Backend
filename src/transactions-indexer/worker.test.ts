import { ingestRange, type IndexerRpcClient } from './worker'

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
    })

    expect(result.txCount).toBe(0)
    expect(queries.filter((q) => q.sql.trim().toUpperCase().startsWith('INSERT')).length).toBe(0)
  })
})
