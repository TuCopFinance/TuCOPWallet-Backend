import { toFunctionSelector } from 'viem'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import {
  _resetHooksApiNeeruTriggerCacheForTests,
  buildDepositTxs,
  buildWithdrawAmountOnlyTxs,
  buildWithdrawTxs,
} from './trigger'

const USER = '0x1111111111111111111111111111111111111111'
const TOKEN_DECIMALS = 18

const APPROVE_SELECTOR = toFunctionSelector('approve(address,uint256)')
const DEPOSIT_SELECTOR = toFunctionSelector('deposit(uint256,uint8)')
const CLOSE_POSITION_SELECTOR = toFunctionSelector('closePosition(uint256)')
const CLOSE_POSITION_PO_SELECTOR = toFunctionSelector(
  'closePositionPrincipalOnly(uint256)',
)

const RAY = 10n ** 27n

interface PreflightReads {
  depositsPaused?: boolean
  globalTvl?: bigint
  globalCap?: bigint
  catR0?: bigint
  catR2?: bigint
  catR3?: bigint
  minDeposit?: bigint
  allowance?: bigint
}

function buildDepositRpc(opts: {
  preflight: PreflightReads
  decimals?: number
}): NeeruIndexerRpcClient {
  const decimals = opts.decimals ?? TOKEN_DECIMALS
  const reads: Required<PreflightReads> = {
    depositsPaused: false,
    globalTvl: 0n,
    globalCap: 10n ** 30n,
    catR0: RAY,
    catR2: 0n,
    catR3: 10n ** 30n,
    minDeposit: 1n,
    allowance: 10n ** 30n,
    ...opts.preflight,
  }

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
      const first = args.contracts[0]?.functionName
      if (first === 'decimals') {
        return [decimals]
      }
      if (first === 'depositsPaused') {
        return [
          reads.depositsPaused,
          reads.globalTvl,
          reads.globalCap,
          [reads.catR0, 0n, reads.catR2, reads.catR3],
          reads.minDeposit,
          reads.allowance,
        ]
      }
      throw new Error(`unexpected multicall: ${String(first)}`)
    }) as never,
    readContract: (async () => {
      throw new Error('readContract not expected in buildDepositTxs')
    }) as never,
  }
  return rpc
}

interface WithdrawRpcReads {
  owner?: string
  closed?: boolean
}

function buildWithdrawRpc(reads: WithdrawRpcReads): NeeruIndexerRpcClient {
  const owner = reads.owner ?? USER
  const closed = reads.closed ?? false
  return {
    getBlockNumber: async () => 1n,
    getBlock: async () => ({ number: 1n, timestamp: 0n }),
    getLogs: async () => [],
    multicall: (async () => {
      throw new Error('multicall not expected for withdraw preflight')
    }) as never,
    readContract: (async () => {
      return [owner, 0, closed, 0n, 0n, 0n, 0n, 0n]
    }) as never,
  }
}

function buildDb(rows: ReadonlyArray<{ position_id: string }>) {
  const queries: { sql: string; params: readonly unknown[] }[] = []
  return {
    db: {
      query: async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params })
        return { rows, rowCount: rows.length }
      },
    } as never,
    queries,
  }
}

describe('buildDepositTxs', () => {
  beforeEach(() => {
    _resetHooksApiNeeruTriggerCacheForTests()
  })

  it('emits a single deposit tx when allowance already covers the amount', async () => {
    const rpc = buildDepositRpc({
      preflight: { allowance: 10n ** 30n },
    })
    const result = await buildDepositTxs({
      address: USER,
      categoryId: 1,
      amount: '100',
      rpc,
    })
    expect(result.transactions).toHaveLength(1)
    const [depositTx] = result.transactions
    expect(depositTx!.networkId).toBe('celo-mainnet')
    expect(depositTx!.value).toBe('0')
    expect(depositTx!.data.slice(0, 10)).toBe(DEPOSIT_SELECTOR)
    // Gas hints let the wallet bypass eth_estimateGas which would
    // revert-simulate against LATEST state on the batched flow.
    expect(depositTx!.gas).toBe('400000')
    expect(depositTx!.estimatedGasUse).toBe('210000')
  })

  it('prepends an approve tx when allowance is insufficient', async () => {
    const rpc = buildDepositRpc({ preflight: { allowance: 0n } })
    const result = await buildDepositTxs({
      address: USER,
      categoryId: 2,
      amount: '50',
      rpc,
    })
    expect(result.transactions).toHaveLength(2)
    const [approveTx, depositTx] = result.transactions
    expect(approveTx!.data.slice(0, 10)).toBe(APPROVE_SELECTOR)
    expect(approveTx!.gas).toBe('65000')
    expect(approveTx!.estimatedGasUse).toBe('47000')
    expect(depositTx!.data.slice(0, 10)).toBe(DEPOSIT_SELECTOR)
    expect(depositTx!.gas).toBe('400000')
    expect(depositTx!.estimatedGasUse).toBe('210000')
  })

  it('rejects an invalid categoryId', async () => {
    const rpc = buildDepositRpc({ preflight: {} })
    await expect(
      buildDepositTxs({
        address: USER,
        categoryId: 4,
        amount: '10',
        rpc,
      }),
    ).rejects.toThrow('INVALID_CATEGORY')
  })

  it('throws DEPOSITS_PAUSED when the contract reports a paused state', async () => {
    const rpc = buildDepositRpc({ preflight: { depositsPaused: true } })
    await expect(
      buildDepositTxs({
        address: USER,
        categoryId: 0,
        amount: '10',
        rpc,
      }),
    ).rejects.toThrow('DEPOSITS_PAUSED')
  })

  it('throws GLOBAL_CAP_EXCEEDED when tvl + amount > globalCap', async () => {
    const rpc = buildDepositRpc({
      preflight: {
        globalTvl: 10n ** 30n,
        globalCap: 10n ** 30n,
      },
    })
    await expect(
      buildDepositTxs({
        address: USER,
        categoryId: 0,
        amount: '1',
        rpc,
      }),
    ).rejects.toThrow('GLOBAL_CAP_EXCEEDED')
  })

  it('throws CATEGORY_CAP_EXCEEDED when cat tvl + amount > cat cap', async () => {
    const rpc = buildDepositRpc({
      preflight: {
        catR2: 5n * 10n ** 18n,
        catR3: 5n * 10n ** 18n,
      },
    })
    await expect(
      buildDepositTxs({
        address: USER,
        categoryId: 1,
        amount: '1',
        rpc,
      }),
    ).rejects.toThrow('CATEGORY_CAP_EXCEEDED')
  })

  it('throws RATE_NOT_SET when r0 < RAY', async () => {
    const rpc = buildDepositRpc({
      preflight: { catR0: RAY - 1n },
    })
    await expect(
      buildDepositTxs({
        address: USER,
        categoryId: 1,
        amount: '10',
        rpc,
      }),
    ).rejects.toThrow('RATE_NOT_SET')
  })

  it('throws AMOUNT_BELOW_MIN when amountWei < minDeposit', async () => {
    const rpc = buildDepositRpc({
      preflight: { minDeposit: 100n * 10n ** 18n },
    })
    await expect(
      buildDepositTxs({
        address: USER,
        categoryId: 1,
        amount: '10',
        rpc,
      }),
    ).rejects.toThrow('AMOUNT_BELOW_MIN')
  })

  it('rejects a non-decimal amount string', async () => {
    const rpc = buildDepositRpc({ preflight: {} })
    await expect(
      buildDepositTxs({
        address: USER,
        categoryId: 0,
        amount: '12.5',
        rpc,
      }),
    ).rejects.toThrow('INVALID_AMOUNT')
  })
})

describe('buildWithdrawTxs', () => {
  it('emits a single closePosition tx on the happy path', async () => {
    const rpc = buildWithdrawRpc({})
    const { db } = buildDb([{ position_id: '42' }])
    const result = await buildWithdrawTxs({
      address: USER,
      positionId: '42',
      rpc,
      db,
    })
    expect(result.transactions).toHaveLength(1)
    const [withdrawTx] = result.transactions
    expect(withdrawTx!.data.slice(0, 10)).toBe(CLOSE_POSITION_SELECTOR)
    expect(withdrawTx!.gas).toBe('320000')
    expect(withdrawTx!.estimatedGasUse).toBe('180000')
  })

  it('throws POSITION_NOT_FOUND when DB returns zero rows', async () => {
    const rpc = buildWithdrawRpc({})
    const { db } = buildDb([])
    await expect(
      buildWithdrawTxs({
        address: USER,
        positionId: '99',
        rpc,
        db,
      }),
    ).rejects.toThrow('POSITION_NOT_FOUND')
  })

  it('throws POSITION_NOT_OWNED when on-chain owner differs', async () => {
    const rpc = buildWithdrawRpc({
      owner: '0x0000000000000000000000000000000000000001',
    })
    const { db } = buildDb([{ position_id: '42' }])
    await expect(
      buildWithdrawTxs({
        address: USER,
        positionId: '42',
        rpc,
        db,
      }),
    ).rejects.toThrow('POSITION_NOT_OWNED')
  })

  it('throws POSITION_ALREADY_CLOSED when on-chain closed flag is true', async () => {
    const rpc = buildWithdrawRpc({ closed: true })
    const { db } = buildDb([{ position_id: '42' }])
    await expect(
      buildWithdrawTxs({
        address: USER,
        positionId: '42',
        rpc,
        db,
      }),
    ).rejects.toThrow('POSITION_ALREADY_CLOSED')
  })

  it('rejects a non-numeric positionId', async () => {
    const rpc = buildWithdrawRpc({})
    const { db } = buildDb([{ position_id: '42' }])
    await expect(
      buildWithdrawTxs({
        address: USER,
        positionId: 'abc',
        rpc,
        db,
      }),
    ).rejects.toThrow('POSITION_NOT_FOUND')
  })
})

describe('buildWithdrawAmountOnlyTxs', () => {
  it('emits a single closePositionPrincipalOnly tx on the happy path', async () => {
    const rpc = buildWithdrawRpc({})
    const { db } = buildDb([{ position_id: '42' }])
    const result = await buildWithdrawAmountOnlyTxs({
      address: USER,
      positionId: '42',
      rpc,
      db,
    })
    expect(result.transactions).toHaveLength(1)
    const [tx0] = result.transactions
    expect(tx0!.data.slice(0, 10)).toBe(CLOSE_POSITION_PO_SELECTOR)
    expect(tx0!.gas).toBe('240000')
    expect(tx0!.estimatedGasUse).toBe('130000')
  })

  it('throws POSITION_NOT_FOUND when DB returns zero rows', async () => {
    const rpc = buildWithdrawRpc({})
    const { db } = buildDb([])
    await expect(
      buildWithdrawAmountOnlyTxs({
        address: USER,
        positionId: '99',
        rpc,
        db,
      }),
    ).rejects.toThrow('POSITION_NOT_FOUND')
  })

  it('throws POSITION_NOT_OWNED when on-chain owner differs', async () => {
    const rpc = buildWithdrawRpc({
      owner: '0x0000000000000000000000000000000000000001',
    })
    const { db } = buildDb([{ position_id: '42' }])
    await expect(
      buildWithdrawAmountOnlyTxs({
        address: USER,
        positionId: '42',
        rpc,
        db,
      }),
    ).rejects.toThrow('POSITION_NOT_OWNED')
  })

  it('throws POSITION_ALREADY_CLOSED when on-chain closed flag is true', async () => {
    const rpc = buildWithdrawRpc({ closed: true })
    const { db } = buildDb([{ position_id: '42' }])
    await expect(
      buildWithdrawAmountOnlyTxs({
        address: USER,
        positionId: '42',
        rpc,
        db,
      }),
    ).rejects.toThrow('POSITION_ALREADY_CLOSED')
  })
})
