import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import {
  _resetHooksApiNeeruCacheForTests,
  getNeeruEarnPositions,
  getNeeruHeldPositions,
} from './positions'

const USER = '0x1111111111111111111111111111111111111111'
const TOKEN_DECIMALS = 18
const TOKEN_SYMBOL = 'COPm'

function catReadTuple(args: {
  r0: bigint
  r1: bigint
  r2: bigint
  r3?: bigint
}): readonly [bigint, bigint, bigint, bigint] {
  return [args.r0, args.r1, args.r2, args.r3 ?? 0n] as const
}

const RATE_A = BigInt(Math.round(1e27 * 1.0001))
const RATE_B = BigInt(Math.round(1e27 * 1.0003))
const RATE_C = BigInt(Math.round(1e27 * 1.0005))
const RATE_D = BigInt(Math.round(1e27 * 1.0007))

interface FakeRpcOpts {
  catReadReturns: ReadonlyArray<readonly [bigint, bigint, bigint, bigint]>
  decimals?: number
  symbol?: string
  accruedById?: Map<string, bigint>
}

function buildFakeRpc(opts: FakeRpcOpts): {
  rpc: NeeruIndexerRpcClient
  multicallCalls: { contracts: ReadonlyArray<{ functionName: string }> }[]
} {
  const multicallCalls: {
    contracts: ReadonlyArray<{ functionName: string }>
  }[] = []
  const decimals = opts.decimals ?? TOKEN_DECIMALS
  const symbol = opts.symbol ?? TOKEN_SYMBOL

  const rpc: NeeruIndexerRpcClient = {
    getBlockNumber: async () => 1n,
    getBlock: async () => ({ number: 1n, timestamp: 0n }),
    getLogs: async () => [],
    multicall: (async (args: {
      contracts: ReadonlyArray<{
        functionName: string
        args: readonly unknown[]
      }>
      allowFailure: boolean
    }) => {
      multicallCalls.push({ contracts: args.contracts })
      if (
        args.contracts.length === 6 &&
        args.contracts[0]?.functionName === 'categories'
      ) {
        return [
          opts.catReadReturns[0],
          opts.catReadReturns[1],
          opts.catReadReturns[2],
          opts.catReadReturns[3],
          decimals,
          symbol,
        ]
      }
      if (args.contracts[0]?.functionName === 'previewAccruedInterest') {
        return args.contracts.map((call) => {
          const id = (call.args[0] as bigint).toString()
          const v = opts.accruedById?.get(id) ?? 0n
          return { status: 'success', result: v }
        })
      }
      throw new Error(
        `unexpected multicall: ${args.contracts[0]?.functionName}`,
      )
    }) as never,
    readContract: (async () => {
      throw new Error('readContract not used in hooks-api positions')
    }) as never,
  }
  return { rpc, multicallCalls }
}

function buildFakeDb(rows: ReadonlyArray<{
  position_id: string
  category: number
  amount: string
}>) {
  const queries: { sql: string; params: readonly unknown[] }[] = []
  return {
    db: {
      query: async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params })
        return { rows, rowCount: rows.length }
      },
    },
    queries,
  }
}

describe('getNeeruEarnPositions', () => {
  beforeEach(() => {
    _resetHooksApiNeeruCacheForTests()
  })

  const catReadReturns = [
    catReadTuple({ r0: RATE_A, r1: 0n, r2: 100_000n * 10n ** 18n }),
    catReadTuple({ r0: RATE_B, r1: BigInt(7 * 86_400), r2: 200_000n * 10n ** 18n }),
    catReadTuple({ r0: RATE_C, r1: BigInt(14 * 86_400), r2: 300_000n * 10n ** 18n }),
    catReadTuple({ r0: RATE_D, r1: BigInt(21 * 86_400), r2: 400_000n * 10n ** 18n }),
  ] as const

  it('returns 4 EarnPositions with balance="0" when no address provided', async () => {
    const { rpc, multicallCalls } = buildFakeRpc({ catReadReturns })
    const { db } = buildFakeDb([])

    const positions = await getNeeruEarnPositions({
      db: db as never,
      rpc,
    })
    expect(positions).toHaveLength(4)
    for (const p of positions) {
      expect(p.appId).toBe('neeru-vaults')
      expect(p.appName).toBe('Neeru Vaults')
      expect(p.networkId).toBe('celo-mainnet')
      expect(p.balance).toBe('0')
      expect(p.tokens).toHaveLength(1)
      expect(p.tokens[0]?.symbol).toBe(TOKEN_SYMBOL)
      expect(p.tokens[0]?.decimals).toBe(TOKEN_DECIMALS)
      expect(p.availableShortcutIds).toEqual(['deposit', 'withdraw'])
    }

    expect(positions[0]?.displayProps.title).toBe('Flexible')
    expect(positions[1]?.displayProps.title).toBe('7 dias')
    expect(positions[2]?.displayProps.title).toBe('14 dias')
    expect(positions[3]?.displayProps.title).toBe('21 dias')

    expect(positions[0]?.displayProps.description).toBe(
      'Genera intereses bloqueando tus Pesos por Flexible',
    )
    expect(positions[1]?.displayProps.description).toBe(
      'Genera intereses bloqueando tus Pesos por 7 dias',
    )

    expect(positions[1]?.shortcutTriggerArgs).toEqual({
      deposit: { categoryId: 1 },
      withdraw: { categoryId: 1 },
    })

    expect(multicallCalls).toHaveLength(1)
    expect(multicallCalls[0]?.contracts[0]?.functionName).toBe('categories')
  })

  it('aggregates amount + previewAccruedInterest per category for a user', async () => {
    const accrued = new Map<string, bigint>([
      ['100', 5n * 10n ** 18n],
      ['101', 3n * 10n ** 18n],
      ['200', 1n * 10n ** 18n],
    ])
    const { rpc, multicallCalls } = buildFakeRpc({
      catReadReturns,
      accruedById: accrued,
    })

    const { db } = buildFakeDb([
      {
        position_id: '100',
        category: 1,
        amount: (50n * 10n ** 18n).toString(),
      },
      {
        position_id: '101',
        category: 1,
        amount: (30n * 10n ** 18n).toString(),
      },
      {
        position_id: '200',
        category: 2,
        amount: (10n * 10n ** 18n).toString(),
      },
    ])

    const positions = await getNeeruEarnPositions({
      address: USER,
      db: db as never,
      rpc,
    })
    expect(positions).toHaveLength(4)

    expect(positions[0]?.balance).toBe('0')
    expect(positions[1]?.balance).toBe('88')
    expect(positions[2]?.balance).toBe('11')
    expect(positions[3]?.balance).toBe('0')

    expect(multicallCalls).toHaveLength(2)
    expect(multicallCalls[1]?.contracts).toHaveLength(3)
    expect(multicallCalls[1]?.contracts[0]?.functionName).toBe(
      'previewAccruedInterest',
    )
  })

  it('caches the catalogue snapshot for 30s', async () => {
    const { rpc, multicallCalls } = buildFakeRpc({ catReadReturns })
    const { db } = buildFakeDb([])

    let nowMs = 1_700_000_000_000
    const now = () => nowMs

    await getNeeruEarnPositions({ db: db as never, rpc, now })
    nowMs += 10_000
    await getNeeruEarnPositions({ db: db as never, rpc, now })
    expect(multicallCalls).toHaveLength(1)

    nowMs += 30_000
    await getNeeruEarnPositions({ db: db as never, rpc, now })
    expect(multicallCalls).toHaveLength(2)
  })

  it('computes dailyYieldRatePercentage from on-chain rate and monthly compound from it', async () => {
    const { rpc } = buildFakeRpc({ catReadReturns })
    const { db } = buildFakeDb([])

    const positions = await getNeeruEarnPositions({
      db: db as never,
      rpc,
    })

    const dataProps1 = positions[1]!.dataProps!
    expect(dataProps1.dailyYieldRatePercentage).toBeCloseTo(0.03, 4)
    const monthly = ((1 + 0.0003) ** 30 - 1) * 100
    expect(dataProps1.yieldRates[0]?.percentage).toBeCloseTo(monthly, 4)
    expect(dataProps1.yieldRates[0]?.label).toBe('Tasa mensual')
  })

  it('emits TVL as decimal string scaled by token decimals', async () => {
    const { rpc } = buildFakeRpc({ catReadReturns })
    const { db } = buildFakeDb([])

    const positions = await getNeeruEarnPositions({
      db: db as never,
      rpc,
    })
    expect(positions[0]?.dataProps?.tvl).toBe('100000')
    expect(positions[1]?.dataProps?.tvl).toBe('200000')
  })

  it('emits safety, manageUrl, termsUrl, contractCreatedAt from config', async () => {
    const { rpc } = buildFakeRpc({ catReadReturns })
    const { db } = buildFakeDb([])

    const positions = await getNeeruEarnPositions({
      db: db as never,
      rpc,
    })
    const dp = positions[0]!.dataProps!
    expect(dp.termsUrl).toBe('https://neerufinance.test/terms')
    expect(dp.manageUrl).toBe('https://neerufinance.test/')
    expect(dp.contractCreatedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(dp.cantSeparateCompoundedInterest).toBe(false)
    expect(dp.safety?.level).toBe('medium')
    expect(dp.safety?.risks).toHaveLength(2)
  })

  it('positionId is celo-mainnet:<contract>:category-N (lowercase)', async () => {
    const { rpc } = buildFakeRpc({ catReadReturns })
    const { db } = buildFakeDb([])

    const positions = await getNeeruEarnPositions({
      db: db as never,
      rpc,
    })
    for (let i = 0; i < 4; i++) {
      expect(positions[i]?.positionId).toMatch(
        /^celo-mainnet:0x[a-f0-9]{40}:category-[0-3]$/,
      )
      expect(positions[i]?.positionId.endsWith(`:category-${i}`)).toBe(true)
    }
  })
})

describe('getNeeruHeldPositions', () => {
  beforeEach(() => {
    _resetHooksApiNeeruCacheForTests()
  })

  it('only returns positions with non-zero balance', async () => {
    const catReadReturns = [
      catReadTuple({ r0: RATE_A, r1: 0n, r2: 0n }),
      catReadTuple({ r0: RATE_B, r1: BigInt(7 * 86_400), r2: 0n }),
      catReadTuple({ r0: RATE_C, r1: BigInt(14 * 86_400), r2: 0n }),
      catReadTuple({ r0: RATE_D, r1: BigInt(21 * 86_400), r2: 0n }),
    ] as const

    const { rpc } = buildFakeRpc({
      catReadReturns,
      accruedById: new Map([['100', 0n]]),
    })
    const { db } = buildFakeDb([
      {
        position_id: '100',
        category: 2,
        amount: (7n * 10n ** 18n).toString(),
      },
    ])

    const positions = await getNeeruHeldPositions({
      address: USER,
      db: db as never,
      rpc,
    })
    expect(positions).toHaveLength(1)
    expect(positions[0]?.positionId.endsWith(':category-2')).toBe(true)
    expect(positions[0]?.balance).toBe('7')
  })
})
