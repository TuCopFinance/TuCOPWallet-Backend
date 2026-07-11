// Ported from valora-inc/hooks (Apache-2.0).
// Original: https://github.com/valora-inc/hooks/blob/main/src/types/positions.ts
// License: Apache-2.0 - see LICENSES/allbridge.md at repo root.
//
// Subset of upstream's position/token types, narrowed to what this port
// emits. We keep field names and JSON shape compatible so the wallet's
// consumer code (which historically read the Valora hooks-api response)
// does not need to change.

import type { Address } from 'viem'

// Serialized decimal number, as a string. Mirrors upstream's
// `SerializedDecimalNumber` brand. Plain string in JSON.
export type SerializedDecimalNumber = string

export type NetworkId = 'celo-mainnet' // backend-scope: Celo only for now

export enum ClaimType {
  Earnings = 'earnings',
  Rewards = 'rewards',
}

export interface DisplayProps {
  title: string
  description: string
  imageUrl: string
  manageUrl: string | undefined
}

export interface YieldRate {
  percentage: number
  label: string
  tokenId: string
}

export interface EarningItem {
  amount: SerializedDecimalNumber
  label: string
  tokenId: string
  includedInPoolBalance?: boolean
}

export interface SafetyRisk {
  isPositive: boolean
  title: string
  category: string
}

export interface Safety {
  level: 'low' | 'medium' | 'high'
  risks: SafetyRisk[]
}

export interface EarnDataProps {
  contractCreatedAt?: string
  manageUrl?: string
  termsUrl?: string
  cantSeparateCompoundedInterest?: boolean
  tvl?: SerializedDecimalNumber
  yieldRates: YieldRate[]
  earningItems: EarningItem[]
  depositTokenId: string
  withdrawTokenId: string
  rewardsPositionIds?: string[]
  claimType?: ClaimType
  withdrawalIncludesClaim?: boolean
  dailyYieldRatePercentage?: number
  safety?: Safety
}

export type TokenCategory = 'claimable'

export interface BaseToken {
  type: 'base-token'
  tokenId: string
  address?: string
  networkId: NetworkId
  symbol: string
  decimals: number
  priceUsd: SerializedDecimalNumber
  balance: SerializedDecimalNumber
  category?: TokenCategory
}

export interface AbstractPosition {
  positionId: string
  address: string
  networkId: NetworkId
  appId: string
  appName: string
  label: string // deprecated upstream; kept for parity
  displayProps: DisplayProps
  dataProps?: EarnDataProps
  tokens: (BaseToken | AppTokenPosition)[]
  availableShortcutIds: string[]
  shortcutTriggerArgs: Record<string, Record<string, unknown>>
}

export interface AppTokenPosition extends AbstractPosition {
  type: 'app-token'
  symbol: string
  decimals: number
  priceUsd: SerializedDecimalNumber
  balance: SerializedDecimalNumber
  supply: SerializedDecimalNumber
  pricePerShare: SerializedDecimalNumber[]
  category?: TokenCategory
}

export interface ContractPosition extends AbstractPosition {
  type: 'contract-position'
  balanceUsd: SerializedDecimalNumber
}

export type Position = AppTokenPosition | ContractPosition

// Shortcut definitions (the lightweight catalogue entries the wallet
// reads from `/hooks-api/v2/getShortcuts`). The wallet uses these to
// know which shortcuts each app exposes.
export interface ShortcutDefinition {
  id: string
  appId: string
  name: string
  description: string
  networkIds: NetworkId[]
  category: 'deposit' | 'withdraw' | 'claim' | 'swap-deposit'
}

// One on-chain transaction the wallet should submit. Matches the shape
// the wallet reads in `src/earn/prepareTransactions.ts`.
export interface PreparedTransaction {
  to: Address
  data: `0x${string}`
  value: string
  networkId: NetworkId
}

export interface TriggerResult {
  transactions: PreparedTransaction[]
  // Reserved for shortcuts that need to surface extra info (e.g. swap-deposit
  // returns the Squid swap blob here). Kept open-typed for now.
  dataProps?: Record<string, unknown>
}

// Argument shapes the wallet sends with `triggerShortcut`. The names
// match the upstream `shortcutTriggerArgs` keys to preserve parity.
export interface DepositTriggerArgs {
  address: string
  networkId: NetworkId
  positionAddress: string
  tokenAddress: string
  tokenDecimals: number
  tokens: { amount: string }[]
}

export interface WithdrawTriggerArgs {
  address: string
  networkId: NetworkId
  positionAddress: string
  tokenDecimals: number
  tokens: { amount: string }[]
}

export interface ClaimRewardsTriggerArgs {
  address: string
  networkId: NetworkId
  positionAddress: string
}
