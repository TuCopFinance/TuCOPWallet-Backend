// Mock the project logger BEFORE importing reorgJob so the warn calls land
// on our spy rather than a `console.warn.bind(console, tag)` reference that
// was captured at module-init time.
const warnMock = jest.fn()
const infoMock = jest.fn()
const debugMock = jest.fn()
const errorMock = jest.fn()

jest.mock('../lib/logger', () => ({
  createLogger: () => ({
    warn: warnMock,
    info: infoMock,
    debug: debugMock,
    error: errorMock,
  }),
}))

import { runReorgReconciliation } from './reorgJob'
import type { NeeruIndexerRpcClient } from './rpc'

interface RecordedQuery {
  sql: string
  params: readonly unknown[]
}

function buildFakeDb(opts: {
  rows: ReadonlyArray<{
    position_id: string
    deposit_tx_hash: string
    deposit_block: string
  }>
}) {
  const queries: RecordedQuery[] = []
  const deletedIds: string[] = []
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const normalised = sql.trim().toUpperCase()
      if (normalised.startsWith('SELECT')) {
        return { rows: opts.rows, rowCount: opts.rows.length }
      }
      if (normalised.startsWith('DELETE')) {
        deletedIds.push(String(params[0]))
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    connect: async () => {
      throw new Error('not used by reorg job')
    },
  }
  return { db, queries, deletedIds }
}

function buildRpc(opts: {
  multicallImpl: (
    args: unknown,
  ) =>
    | ReadonlyArray<
        | { status: 'success'; result: readonly unknown[] }
        | { status: 'failure'; error: Error }
      >
    | Promise<
        ReadonlyArray<
          | { status: 'success'; result: readonly unknown[] }
          | { status: 'failure'; error: Error }
        >
      >
}) {
  const multicallCalls: unknown[] = []
  const rpc: NeeruIndexerRpcClient = {
    getBlockNumber: async () => 0n,
    getBlock: async () => ({ number: 0n, timestamp: 0n }),
    getLogs: async () => [],
    multicall: (async (args: unknown) => {
      multicallCalls.push(args)
      return opts.multicallImpl(args)
    }) as never,
    readContract: (async () => {
      throw new Error('not used by reorg job')
    }) as never,
    call: (async () => {
      throw new Error('call not used by reorg job')
    }) as never,
  }
  return { rpc, multicallCalls }
}

describe('runReorgReconciliation', () => {
  const ZERO = '0x0000000000000000000000000000000000000000'
  const ALICE = '0x1111111111111111111111111111111111111111'

  beforeEach(() => {
    warnMock.mockReset()
    infoMock.mockReset()
    debugMock.mockReset()
    errorMock.mockReset()
  })

  it('deletes rows whose on-chain owner is the zero address (reorged), keeps live rows', async () => {
    const rows = [
      {
        position_id: '100',
        deposit_tx_hash: '0x' + 'aa'.repeat(32),
        deposit_block: '1234568',
      },
      {
        position_id: '101',
        deposit_tx_hash: '0x' + 'bb'.repeat(32),
        deposit_block: '1234569',
      },
      {
        position_id: '102',
        deposit_tx_hash: '0x' + 'cc'.repeat(32),
        deposit_block: '1234570',
      },
    ]
    const { db, deletedIds } = buildFakeDb({ rows })
    const { rpc } = buildRpc({
      multicallImpl: () => [
        // position 100 alive
        { status: 'success', result: [ALICE, 1, false, 1n, 1n, 1n, 1n, 1n] },
        // position 101 reorged (owner zero)
        { status: 'success', result: [ZERO, 0, false, 0n, 0n, 0n, 0n, 0n] },
        // position 102 alive
        { status: 'success', result: [ALICE, 2, false, 1n, 1n, 1n, 1n, 1n] },
      ],
    })

    const result = await runReorgReconciliation({
      db: db as never,
      rpc,
    })
    expect(result).toEqual({ scanned: 3, deleted: 1 })
    expect(deletedIds).toEqual(['101'])

    // Exactly one warn line about the reorged position, with full identifiers.
    const warnCalls = warnMock.mock.calls.map((c) => String(c[0]))
    const reorgLine = warnCalls.find((m) => m.includes('[neeru:reorg]'))
    expect(reorgLine).toBeDefined()
    expect(reorgLine).toContain('positionId=101')
    expect(reorgLine).toContain('depositTxHash=0x' + 'bb'.repeat(32))
    expect(reorgLine).toContain(
      'onchainStatus="owner=0x0000000000000000000000000000000000000000"',
    )
  })

  it('deletes the row when the on-chain call reverts (and logs the revert reason with full positionId)', async () => {
    const rows = [
      {
        position_id: '999',
        deposit_tx_hash: '0x' + 'ff'.repeat(32),
        deposit_block: '1234999',
      },
    ]
    const { db, deletedIds } = buildFakeDb({ rows })
    const { rpc } = buildRpc({
      multicallImpl: () => [
        {
          status: 'failure',
          error: new Error('execution reverted: PositionNotFound()'),
        },
      ],
    })

    const result = await runReorgReconciliation({
      db: db as never,
      rpc,
    })
    expect(result).toEqual({ scanned: 1, deleted: 1 })
    expect(deletedIds).toEqual(['999'])

    const warnCalls = warnMock.mock.calls.map((c) => String(c[0]))
    const reorgLine = warnCalls.find((m) => m.includes('[neeru:reorg]'))
    expect(reorgLine).toBeDefined()
    expect(reorgLine).toContain('positionId=999')
    expect(reorgLine).toContain('depositTxHash=0x' + 'ff'.repeat(32))
    expect(reorgLine).toContain('depositBlock=1234999')
    expect(reorgLine).toContain('revert: execution reverted: PositionNotFound()')
  })

  it('is a no-op when no rows are in the last 24h', async () => {
    const { db } = buildFakeDb({ rows: [] })
    const { rpc, multicallCalls } = buildRpc({
      multicallImpl: () => [],
    })
    const result = await runReorgReconciliation({
      db: db as never,
      rpc,
    })
    expect(result).toEqual({ scanned: 0, deleted: 0 })
    expect(multicallCalls).toHaveLength(0)
  })
})
