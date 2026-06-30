import type { Pool } from 'pg'
import {
  backfillAddress,
  _testHelpers,
  triggerBackfill,
  wrapPublicClientAsBackfillRpc,
  type BackfillViemLike,
} from './backfill'

const ADDR = '0x1111111111111111111111111111111111111111'

interface ReceiptShape {
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
}

interface TxShape {
  hash: `0x${string}`
  from: string
  to: string | null
  transactionIndex: number | null
  value: bigint
  input: string
  blockNumber: bigint
}

function buildTx(overrides: Partial<TxShape> = {}): TxShape {
  return {
    hash: '0xaaa1' as `0x${string}`,
    from: ADDR,
    to: '0x2222222222222222222222222222222222222222',
    transactionIndex: 0,
    value: 0n,
    input: '0x',
    blockNumber: 100n,
    ...overrides,
  }
}

function buildReceipt(overrides: Partial<ReceiptShape> = {}): ReceiptShape {
  return {
    status: 'success',
    transactionIndex: 0,
    gasUsed: 21000n,
    effectiveGasPrice: 5_000_000_000n,
    logs: [],
    ...overrides,
  }
}

interface MockRpcOptions {
  tip?: bigint
  outboundLogs?: ReadonlyArray<{ transactionHash: string; blockNumber: bigint }>
  inboundLogs?: ReadonlyArray<{ transactionHash: string; blockNumber: bigint }>
  txByHash?: Record<string, TxShape>
  receiptByHash?: Record<string, ReceiptShape>
  blockTimestamp?: bigint
}

function buildMockRpc(opts: MockRpcOptions = {}) {
  const tip = opts.tip ?? 200n
  const outboundLogs = opts.outboundLogs ?? []
  const inboundLogs = opts.inboundLogs ?? []
  const txByHash = opts.txByHash ?? {}
  const receiptByHash = opts.receiptByHash ?? {}
  const blockTimestamp = opts.blockTimestamp ?? 1_700_000_000n

  return {
    getBlockNumber: jest.fn(async () => tip),
    getLogs: jest.fn(
      async (args: {
        fromBlock: bigint
        toBlock: bigint
        topics: ReadonlyArray<string | string[] | null>
      }) => {
        const topic1 = args.topics[1]
        const topic2 = args.topics[2]
        if (topic2 === null && typeof topic1 === 'string') return outboundLogs
        if (topic1 === null && typeof topic2 === 'string') return inboundLogs
        return []
      },
    ),
    getBlock: jest.fn(async () => ({ timestamp: blockTimestamp })),
    getTransaction: jest.fn(async (args: { hash: string }) => {
      const t = txByHash[args.hash.toLowerCase()]
      if (!t) throw new Error(`no tx fixture for ${args.hash}`)
      return t
    }),
    getTransactionReceipt: jest.fn(async (args: { hash: string }) => {
      const r = receiptByHash[args.hash.toLowerCase()]
      if (!r) throw new Error(`no receipt fixture for ${args.hash}`)
      return r
    }),
  }
}

function buildMockDb(): Pool {
  const queryClient = jest.fn(async (sql: string) => {
    const normalized = sql.trim().toUpperCase()
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [] }
    }
    if (normalized.startsWith('INSERT INTO TX')) {
      return { rows: [{ id: '42' }] }
    }
    if (normalized.startsWith('SELECT ID FROM TX')) {
      return { rows: [] }
    }
    if (normalized.startsWith('INSERT INTO TX_LOG')) {
      return { rows: [] }
    }
    return { rows: [] }
  })
  const release = jest.fn()
  const connect = jest.fn(async () => ({
    query: queryClient,
    release,
  }))
  const query = jest.fn(async () => ({ rows: [] }))
  return { connect, query } as unknown as Pool
}

describe('backfillAddress', () => {
  beforeEach(() => {
    _testHelpers.clearInProgress()
  })

  it('scans depth blocks and reports counts', async () => {
    const rpc = buildMockRpc({ tip: 100n })
    const db = buildMockDb()

    const result = await backfillAddress(db, ADDR, { rpc, depthBlocks: 50 })

    expect(result.blocksScanned).toBe(51) // inclusive range 50..100
    expect(result.txsFound).toBe(0)
    expect(rpc.getLogs).toHaveBeenCalled()
  })

  it('clamps fromBlock to 0n when depth > tip', async () => {
    const rpc = buildMockRpc({ tip: 5n })
    const db = buildMockDb()

    const result = await backfillAddress(db, ADDR, { rpc, depthBlocks: 1000 })

    expect(result.blocksScanned).toBe(6) // 0..5
    const firstCallArgs = (rpc.getLogs as jest.Mock).mock.calls[0][0]
    expect(firstCallArgs.fromBlock).toBe(0n)
  })

  it('fetches tx + receipt + block and persists for each unique hash', async () => {
    const HASH = '0xabc1230000000000000000000000000000000000000000000000000000000001'
    const rpc = buildMockRpc({
      tip: 100n,
      outboundLogs: [{ transactionHash: HASH, blockNumber: 90n }],
      txByHash: {
        [HASH]: buildTx({ hash: HASH as `0x${string}`, blockNumber: 90n }),
      },
      receiptByHash: { [HASH]: buildReceipt() },
    })
    const db = buildMockDb()

    const result = await backfillAddress(db, ADDR, { rpc, depthBlocks: 50 })

    expect(result.txsFound).toBe(1)
    expect(rpc.getTransaction).toHaveBeenCalledWith({ hash: HASH })
    expect(rpc.getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH })
    expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 90n })
  })

  it('dedupes hashes that appear in both inbound and outbound logs', async () => {
    const HASH = '0xabc1230000000000000000000000000000000000000000000000000000000002'
    const rpc = buildMockRpc({
      tip: 100n,
      outboundLogs: [{ transactionHash: HASH, blockNumber: 90n }],
      inboundLogs: [{ transactionHash: HASH, blockNumber: 90n }],
      txByHash: {
        [HASH]: buildTx({ hash: HASH as `0x${string}`, blockNumber: 90n }),
      },
      receiptByHash: { [HASH]: buildReceipt() },
    })
    const db = buildMockDb()

    const result = await backfillAddress(db, ADDR, { rpc, depthBlocks: 50 })

    expect(result.txsFound).toBe(1)
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1)
  })

  it('chunks getLogs into 5000-block batches', async () => {
    const rpc = buildMockRpc({ tip: 12_000n })
    const db = buildMockDb()

    await backfillAddress(db, ADDR, { rpc, depthBlocks: 10_000 })

    // 10k-block range with 5k batch size = 3 chunks (0..4999, 5000..9999, 10000..12000)
    // x 2 calls per chunk (outbound + inbound)
    expect(rpc.getLogs).toHaveBeenCalledTimes(3 * 2)
  })

  it('does not throw when a tx lookup fails (logs and continues)', async () => {
    const HASH = '0xabc1230000000000000000000000000000000000000000000000000000000003'
    const rpc = buildMockRpc({
      tip: 100n,
      outboundLogs: [{ transactionHash: HASH, blockNumber: 90n }],
      // No fixtures => getTransaction/getTransactionReceipt will throw
    })
    const db = buildMockDb()

    await expect(
      backfillAddress(db, ADDR, { rpc, depthBlocks: 50 }),
    ).resolves.toEqual({ blocksScanned: 51, txsFound: 0 })
  })
})

describe('wrapPublicClientAsBackfillRpc', () => {
  // Regression for the silent-drop bug we hit in prod: the previous
  // implementation cast viem's PublicClient directly as BackfillRpcClient
  // and called the typed `getLogs({topics})`, which silently dropped the
  // topics filter so Forno received `topics: []` and timed out at 30 s.
  // The fix routes through `request({ method: 'eth_getLogs', params })`;
  // these assertions pin the payload shape so a future refactor cannot
  // regress to the typed-method form unnoticed.
  it('passes topics through to eth_getLogs as a JSON-RPC request', async () => {
    const requestMock = jest.fn(async () => [
      { transactionHash: '0xabc', blockNumber: '0x64' },
    ])
    const viem: BackfillViemLike = {
      getBlockNumber: jest.fn(),
      getBlock: jest.fn(),
      getTransaction: jest.fn(),
      getTransactionReceipt: jest.fn(),
      request: requestMock,
    }
    const rpc = wrapPublicClientAsBackfillRpc(viem)
    const topics: ReadonlyArray<string | string[] | null> = [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      null,
    ]

    const result = await rpc.getLogs({
      topics,
      fromBlock: 100n,
      toBlock: 200n,
    })

    expect(requestMock).toHaveBeenCalledTimes(1)
    const calls = requestMock.mock.calls as unknown as Array<
      Array<{
        method: string
        params: Array<{ topics: unknown; fromBlock: string; toBlock: string }>
      }>
    >
    const args = calls[0]?.[0]
    expect(args?.method).toBe('eth_getLogs')
    expect(args?.params[0]?.topics).toEqual(topics)
    expect(args?.params[0]?.fromBlock).toBe('0x64')
    expect(args?.params[0]?.toBlock).toBe('0xc8')
    expect(result).toEqual([{ transactionHash: '0xabc', blockNumber: 100n }])
  })
})

describe('triggerBackfill', () => {
  beforeEach(() => {
    _testHelpers.clearInProgress()
  })

  it('marks the address as in-progress, then clears it after the job finishes', async () => {
    const rpc = buildMockRpc({ tip: 100n })
    const db = buildMockDb()

    triggerBackfill(db, ADDR, { rpc, depthBlocks: 10 })

    expect(_testHelpers.isInProgress(ADDR)).toBe(true)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 5))
    expect(_testHelpers.isInProgress(ADDR)).toBe(false)
  })

  it('updates backfill_completed_at on success', async () => {
    const rpc = buildMockRpc({ tip: 100n })
    const db = buildMockDb()

    triggerBackfill(db, ADDR, { rpc, depthBlocks: 10 })
    await new Promise((r) => setTimeout(r, 5))

    const calls = (db.query as jest.Mock).mock.calls
    const updateCall = calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('backfill_completed_at = now()'),
    )
    expect(updateCall).toBeDefined()
    expect(updateCall![1]).toEqual([ADDR.toLowerCase()])
  })

  it('does NOT trigger a second concurrent backfill for the same address', async () => {
    const rpc = buildMockRpc({ tip: 100n })
    const db = buildMockDb()

    triggerBackfill(db, ADDR, { rpc, depthBlocks: 10 })
    triggerBackfill(db, ADDR, { rpc, depthBlocks: 10 })
    await new Promise((r) => setTimeout(r, 5))

    expect((rpc.getBlockNumber as jest.Mock).mock.calls.length).toBe(1)
  })

  it('still clears in-progress on error', async () => {
    const rpc = buildMockRpc({ tip: 100n })
    ;(rpc.getBlockNumber as jest.Mock).mockRejectedValueOnce(new Error('rpc down'))
    const db = buildMockDb()

    triggerBackfill(db, ADDR, { rpc, depthBlocks: 10 })
    await new Promise((r) => setTimeout(r, 5))

    expect(_testHelpers.isInProgress(ADDR)).toBe(false)
  })
})
