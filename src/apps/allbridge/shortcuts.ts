// Ported from valora-inc/hooks (Apache-2.0).
// Original: https://github.com/valora-inc/hooks/blob/main/src/apps/allbridge/shortcuts.ts
// License: Apache-2.0 - see LICENSES/allbridge.md at repo root.
//
// Differences vs upstream:
//
// - Upstream wraps shortcuts in zod-validated `createShortcut(...)` from a
//   custom runtime. This backend exposes plain trigger functions with
//   typed args; HTTP-layer validation will live in PR 4. Argument names
//   match upstream's `triggerInputShape` exactly so the wallet does not
//   need to change what it sends.
//
// - `simulateTransactions` (upstream's gas-estimation pre-flight) is
//   dropped. The wallet does its own gas estimate after receiving the
//   txs, and the upstream `DEFAULT_DEPOSIT_GAS` fallback was only ever
//   filled in when simulation failed - removing it surfaces the same
//   "wallet computes gas locally" code path on success.
//
// - `swap-deposit` is intentionally NOT ported here. It needs a Squid
//   posthook builder; this PR is positions + simple shortcuts only. PR
//   5 (`feat/hooks-api-trigger-shortcut`) layers swap-deposit on top.
//
// - `categoryof claim-rewards` upstream is `'claim'`; mirrored here.

import { encodeFunctionData, erc20Abi, parseUnits, type Address, type Hex } from 'viem'
import { APP_ID } from './manifest'
import { poolAbi } from './abis/pool'
import type {
  ClaimRewardsTriggerArgs,
  DepositTriggerArgs,
  PreparedTransaction,
  ShortcutDefinition,
  TriggerResult,
  WithdrawTriggerArgs,
} from './types'
import { getCeloPublicClient } from './rpc'

const NETWORK_ID = 'celo-mainnet' as const

const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: 'deposit',
    appId: APP_ID,
    name: 'Deposit',
    description: 'Lend your assets to earn interest',
    networkIds: [NETWORK_ID],
    category: 'deposit',
  },
  {
    id: 'withdraw',
    appId: APP_ID,
    name: 'Withdraw',
    description: 'Withdraw your assets',
    networkIds: [NETWORK_ID],
    category: 'withdraw',
  },
  {
    id: 'claim-rewards',
    appId: APP_ID,
    name: 'Claim',
    description: 'Claim rewards',
    networkIds: [NETWORK_ID],
    category: 'claim',
  },
  {
    id: 'swap-deposit',
    appId: APP_ID,
    name: 'Swap & Deposit',
    description: 'Swap assets and lend them to earn interest',
    networkIds: [NETWORK_ID],
    category: 'swap-deposit',
  },
]

export function getShortcuts(): ShortcutDefinition[] {
  // Return a shallow copy so callers can mutate without poisoning the
  // module-level array.
  return SHORTCUTS.map((s) => ({ ...s, networkIds: [...s.networkIds] }))
}

function tx(
  to: Address,
  data: Hex,
  value = '0',
): PreparedTransaction {
  return { to, data, value, networkId: NETWORK_ID }
}

export async function triggerDeposit(args: DepositTriggerArgs): Promise<TriggerResult> {
  const { address, positionAddress, tokenAddress, tokenDecimals, tokens } = args
  if (tokens.length !== 1 || tokens[0] === undefined) {
    throw new Error('triggerDeposit: tokens must have length 1')
  }

  const amount = parseUnits(tokens[0].amount, tokenDecimals)
  const wallet = address as Address
  const spender = positionAddress as Address
  const token = tokenAddress as Address

  const client = getCeloPublicClient()
  const allowance = (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [wallet, spender],
  })) as bigint

  const out: PreparedTransaction[] = []
  if (allowance < amount) {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    })
    out.push(tx(token, approveData))
  }

  const depositData = encodeFunctionData({
    abi: poolAbi,
    functionName: 'deposit',
    args: [amount],
  })
  out.push(tx(spender, depositData))

  return { transactions: out }
}

export async function triggerWithdraw(args: WithdrawTriggerArgs): Promise<TriggerResult> {
  const { positionAddress, tokenDecimals, tokens } = args
  if (tokens.length !== 1 || tokens[0] === undefined) {
    throw new Error('triggerWithdraw: tokens must have length 1')
  }

  const amount = parseUnits(tokens[0].amount, tokenDecimals)
  const spender = positionAddress as Address

  const data = encodeFunctionData({
    abi: poolAbi,
    functionName: 'withdraw',
    args: [amount],
  })

  return { transactions: [tx(spender, data)] }
}

export async function triggerClaimRewards(
  args: ClaimRewardsTriggerArgs,
): Promise<TriggerResult> {
  const { positionAddress } = args
  const spender = positionAddress as Address

  const data = encodeFunctionData({
    abi: poolAbi,
    functionName: 'claimRewards',
    args: [],
  })

  return { transactions: [tx(spender, data)] }
}
