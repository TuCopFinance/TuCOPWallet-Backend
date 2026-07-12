// Builders that translate a Neeru shortcut request into the ordered
// list of tx calldata the wallet will sign and submit. Each builder:
//
// - reads only opaque positional outputs from the on-chain reads (the
//   contract field semantics never leak into source via comments or
//   names; results are tracked by index, mirroring positions.ts);
// - issues one Multicall3 batch for the preflight checks (allowFailure
//   = false so a revert short-circuits with a clear error);
// - returns a `{ to, data, value, networkId }` tuple per tx.

import { encodeFunctionData } from 'viem'
import type { Pool } from 'pg'
import { CONTRACT_ADDRESS, READ_ABI } from '../../neeru-indexer/abi'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import {
  ERC20_ALLOWANCE_ABI,
  ERC20_READ_ABI,
  ERC20_WRITE_ABI,
  HOOKS_READ_ABI,
  HOOKS_WRITE_ABI,
} from '../neeru-abi'
import {
  NEERU_DEPOSIT_TOKEN_ADDRESS,
  hooksApiConfigured,
} from '../config'
import type { NetworkId } from './types'

const NETWORK_ID: NetworkId = 'celo-mainnet'
const RAY = 10n ** 27n
const TOKEN_INFO_TTL_MS = 30_000
const VALID_CATEGORIES: ReadonlySet<number> = new Set([0, 1, 2, 3])
const POSITION_ID_RE = /^\d+$/

export interface ShortcutTransaction {
  to: `0x${string}`
  data: `0x${string}`
  value: string
  networkId: NetworkId
  gas?: string
  estimatedGasUse?: string
}

// Gas hints for shortcut transactions. The wallet-side prepare step runs
// `eth_estimateGas` against LATEST state, which reverts on a batched flow
// where a paired allowance-setting tx has not executed yet. Supplying the
// hint here bypasses the failed simulation without shipping wallet code.
// Values are empirical and include ~15% headroom on top of observed use;
// `estimatedGasUse` is the user-facing number.
const APPROVE_GAS_LIMIT = '65000'
const APPROVE_GAS_ESTIMATED = '47000'
const DEPOSIT_GAS_LIMIT = '260000'
const DEPOSIT_GAS_ESTIMATED = '210000'
const WITHDRAW_GAS_LIMIT = '230000'
const WITHDRAW_GAS_ESTIMATED = '180000'
const WITHDRAW_AMOUNT_ONLY_GAS_LIMIT = '170000'
const WITHDRAW_AMOUNT_ONLY_GAS_ESTIMATED = '130000'

interface TokenInfoSnapshot {
  fetchedAtMs: number
  decimals: number
}

let tokenInfoCache: TokenInfoSnapshot | null = null

export function _resetHooksApiNeeruTriggerCacheForTests(): void {
  tokenInfoCache = null
}

interface MulticallContract {
  address: `0x${string}`
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
}

async function getTokenDecimals(
  rpc: NeeruIndexerRpcClient,
  now: () => number,
): Promise<number> {
  if (tokenInfoCache && now() - tokenInfoCache.fetchedAtMs < TOKEN_INFO_TTL_MS) {
    return tokenInfoCache.decimals
  }
  const calls: MulticallContract[] = [
    {
      address: NEERU_DEPOSIT_TOKEN_ADDRESS,
      abi: ERC20_READ_ABI as unknown as readonly unknown[],
      functionName: 'decimals',
      args: [] as const,
    },
  ]
  const results = (await rpc.multicall({
    contracts: calls as unknown as Parameters<
      NeeruIndexerRpcClient['multicall']
    >[0]['contracts'],
    allowFailure: false,
  })) as unknown as readonly unknown[]
  const decimals = Number(results[0] as number | bigint)
  tokenInfoCache = { fetchedAtMs: now(), decimals }
  return decimals
}

function assertConfigured(): void {
  if (!hooksApiConfigured()) {
    throw new Error('NEERU_NOT_CONFIGURED')
  }
}

function lowerAddress(value: string): `0x${string}` {
  return value.toLowerCase() as `0x${string}`
}

function tx(
  to: `0x${string}`,
  data: `0x${string}`,
  gasHints?: { gas: string; estimatedGasUse: string },
): ShortcutTransaction {
  return {
    to,
    data,
    value: '0',
    networkId: NETWORK_ID,
    ...(gasHints && { gas: gasHints.gas, estimatedGasUse: gasHints.estimatedGasUse }),
  }
}

export interface BuildDepositTxsArgs {
  address: string
  categoryId: number
  amount: string
  rpc: NeeruIndexerRpcClient
  now?: () => number
}

export async function buildDepositTxs(
  args: BuildDepositTxsArgs,
): Promise<{ transactions: ShortcutTransaction[] }> {
  assertConfigured()
  const { address, categoryId, amount, rpc } = args
  const now = args.now ?? (() => Date.now())

  if (!VALID_CATEGORIES.has(categoryId)) {
    throw new Error('INVALID_CATEGORY')
  }
  if (!POSITION_ID_RE.test(amount)) {
    throw new Error('INVALID_AMOUNT')
  }

  const decimals = await getTokenDecimals(rpc, now)
  const amountWei = BigInt(amount) * 10n ** BigInt(decimals)
  if (amountWei <= 0n) {
    throw new Error('INVALID_AMOUNT')
  }

  const userAddress = lowerAddress(address)

  const preflightCalls: MulticallContract[] = [
    {
      address: CONTRACT_ADDRESS,
      abi: HOOKS_READ_ABI as unknown as readonly unknown[],
      functionName: 'depositsPaused',
      args: [] as const,
    },
    {
      address: CONTRACT_ADDRESS,
      abi: HOOKS_READ_ABI as unknown as readonly unknown[],
      functionName: 'globalTvl',
      args: [] as const,
    },
    {
      address: CONTRACT_ADDRESS,
      abi: HOOKS_READ_ABI as unknown as readonly unknown[],
      functionName: 'globalCap',
      args: [] as const,
    },
    {
      address: CONTRACT_ADDRESS,
      abi: HOOKS_READ_ABI as unknown as readonly unknown[],
      functionName: 'tranches',
      args: [categoryId] as const,
    },
    {
      address: CONTRACT_ADDRESS,
      abi: HOOKS_READ_ABI as unknown as readonly unknown[],
      functionName: 'minDeposit',
      args: [] as const,
    },
    {
      address: NEERU_DEPOSIT_TOKEN_ADDRESS,
      abi: ERC20_ALLOWANCE_ABI as unknown as readonly unknown[],
      functionName: 'allowance',
      args: [userAddress, CONTRACT_ADDRESS] as const,
    },
  ]

  const results = (await rpc.multicall({
    contracts: preflightCalls as unknown as Parameters<
      NeeruIndexerRpcClient['multicall']
    >[0]['contracts'],
    allowFailure: false,
  })) as unknown as readonly unknown[]

  const depositsPaused = Boolean(results[0])
  if (depositsPaused) {
    throw new Error('DEPOSITS_PAUSED')
  }

  const globalTvl = BigInt(results[1] as bigint | number | string)
  const globalCap = BigInt(results[2] as bigint | number | string)
  if (globalTvl + amountWei > globalCap) {
    throw new Error('GLOBAL_CAP_EXCEEDED')
  }

  const catReadTuple = results[3] as readonly unknown[]
  const r0 = BigInt(catReadTuple[0] as bigint | number | string)
  const r2 = BigInt(catReadTuple[2] as bigint | number | string)
  const r3 = BigInt(catReadTuple[3] as bigint | number | string)
  if (r2 + amountWei > r3) {
    throw new Error('CATEGORY_CAP_EXCEEDED')
  }
  if (r0 < RAY) {
    throw new Error('RATE_NOT_SET')
  }

  const minDeposit = BigInt(results[4] as bigint | number | string)
  if (amountWei < minDeposit) {
    throw new Error('AMOUNT_BELOW_MIN')
  }

  const allowance = BigInt(results[5] as bigint | number | string)

  const out: ShortcutTransaction[] = []
  if (allowance < amountWei) {
    const approveData = encodeFunctionData({
      abi: ERC20_WRITE_ABI,
      functionName: 'approve',
      args: [CONTRACT_ADDRESS, amountWei],
    })
    out.push(
      tx(NEERU_DEPOSIT_TOKEN_ADDRESS, approveData, {
        gas: APPROVE_GAS_LIMIT,
        estimatedGasUse: APPROVE_GAS_ESTIMATED,
      }),
    )
  }

  const depositData = encodeFunctionData({
    abi: HOOKS_WRITE_ABI,
    functionName: 'deposit',
    args: [amountWei, categoryId],
  })
  out.push(
    tx(CONTRACT_ADDRESS, depositData, {
      gas: DEPOSIT_GAS_LIMIT,
      estimatedGasUse: DEPOSIT_GAS_ESTIMATED,
    }),
  )

  return { transactions: out }
}

export interface BuildWithdrawTxsArgs {
  address: string
  positionId: string
  rpc: NeeruIndexerRpcClient
  db: Pool
}

interface OpenPositionRow {
  position_id: string
}

async function preflightWithdraw(
  args: BuildWithdrawTxsArgs,
): Promise<{ positionIdBn: bigint }> {
  assertConfigured()
  const { address, positionId, rpc, db } = args

  if (!POSITION_ID_RE.test(positionId)) {
    throw new Error('POSITION_NOT_FOUND')
  }
  const positionIdBn = BigInt(positionId)
  const userAddress = lowerAddress(address)

  const { rows } = await db.query<OpenPositionRow>(
    `SELECT 1 AS position_id
       FROM neeru_positions
      WHERE position_id = $1
        AND user_address = $2
        AND closed = FALSE`,
    [positionId, userAddress],
  )
  if (rows.length === 0) {
    throw new Error('POSITION_NOT_FOUND')
  }

  const tuple = (await rpc.readContract({
    address: CONTRACT_ADDRESS,
    abi: READ_ABI,
    functionName: 'positions',
    args: [positionIdBn],
  })) as readonly unknown[]

  const owner = String(tuple[0] as string).toLowerCase()
  const closedFlag = Boolean(tuple[2])
  if (owner !== userAddress) {
    throw new Error('POSITION_NOT_OWNED')
  }
  if (closedFlag) {
    throw new Error('POSITION_ALREADY_CLOSED')
  }

  return { positionIdBn }
}

export async function buildWithdrawTxs(
  args: BuildWithdrawTxsArgs,
): Promise<{ transactions: ShortcutTransaction[] }> {
  const { positionIdBn } = await preflightWithdraw(args)
  const data = encodeFunctionData({
    abi: HOOKS_WRITE_ABI,
    functionName: 'closePosition',
    args: [positionIdBn],
  })
  return {
    transactions: [
      tx(CONTRACT_ADDRESS, data, {
        gas: WITHDRAW_GAS_LIMIT,
        estimatedGasUse: WITHDRAW_GAS_ESTIMATED,
      }),
    ],
  }
}

export async function buildWithdrawAmountOnlyTxs(
  args: BuildWithdrawTxsArgs,
): Promise<{ transactions: ShortcutTransaction[] }> {
  const { positionIdBn } = await preflightWithdraw(args)
  const data = encodeFunctionData({
    abi: HOOKS_WRITE_ABI,
    functionName: 'closePositionPrincipalOnly',
    args: [positionIdBn],
  })
  return {
    transactions: [
      tx(CONTRACT_ADDRESS, data, {
        gas: WITHDRAW_AMOUNT_ONLY_GAS_LIMIT,
        estimatedGasUse: WITHDRAW_AMOUNT_ONLY_GAS_ESTIMATED,
      }),
    ],
  }
}
