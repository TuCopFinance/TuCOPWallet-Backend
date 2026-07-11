// Ported from valora-inc/hooks (Apache-2.0).
// Original: https://github.com/valora-inc/hooks/blob/main/src/apps/allbridge/api.ts
// License: Apache-2.0 - see LICENSES/allbridge.md at repo root.
//
// Allbridge Core REST client. Same endpoint as upstream
// (https://core.api.allbridgecoreapi.net/token-info), same SDK agent
// header. Differences from upstream:
//
// - LRU import removed (uses a single-entry, time-boxed cache inline; one
//   dependency less, behavior identical).
// - Optional API key read from `process.env.ALLBRIDGE_API_KEY` instead of
//   a config object - matches the conventions in this repo.
// - Narrowed to the chain symbols this backend supports (Celo only).

import type { Address } from 'viem'
import { createLogger } from '../../lib/logger'
import type { NetworkId } from './types'

const log = createLogger('app:allbridge:api')

export type SupportedAllbridgeChainSymbols = 'CEL'

const NETWORK_ID_TO_ALLBRIDGE_BLOCKCHAIN_SYMBOL: Record<
  NetworkId,
  SupportedAllbridgeChainSymbols | undefined
> = {
  'celo-mainnet': 'CEL',
}

export interface PoolInfo {
  aValue: string
  dValue: string
  tokenBalance: string
  vUsdBalance: string
  totalLpAmount: string
  accRewardPerShareP: string
  p: number
}

export interface TransferTime {
  allbridge: number
  wormhole: number
  cctp: number | null
}

export interface TxCostAmount {
  swap: string
  transfer: string
  maxAmount: string
}

export interface TokenInfo {
  name: string
  poolAddress: Address
  tokenAddress: Address
  decimals: number
  symbol: string
  poolInfo: PoolInfo
  feeShare: string
  apr: string
  apr7d: string
  apr30d: string
  lpRate: string
}

export interface NetworkInfo {
  tokens: TokenInfo[]
  chainId: number
  bridgeAddress: Address
  swapAddress: Address
  transferTime: Record<string, TransferTime>
  confirmations: number
  txCostAmount: TxCostAmount
}

type AllbridgeApiResponse = Record<SupportedAllbridgeChainSymbols, NetworkInfo>

const CACHE_TTL_MS = 10 * 60 * 1000
const TOKEN_INFO_URL = 'https://core.api.allbridgecoreapi.net/token-info'

interface CacheEntry {
  expiresAt: number
  value: AllbridgeApiResponse
}

let cached: CacheEntry | null = null

export function clearAllbridgeApiCache(): void {
  cached = null
}

export async function getAllbridgeTokenInfo({
  networkId,
}: {
  networkId: NetworkId
}): Promise<NetworkInfo | undefined> {
  const now = Date.now()
  let response: AllbridgeApiResponse | undefined =
    cached && cached.expiresAt > now ? cached.value : undefined

  if (!response) {
    const headers: Record<string, string> = {
      // Same value upstream uses. Allbridge whitelists known SDK agents.
      'x-Sdk-Agent': 'AllbridgeCoreSDK/3.21.0',
    }
    const apiKey = process.env.ALLBRIDGE_API_KEY
    if (apiKey) {
      headers['valora-allbridge-core'] = apiKey
    }

    const res = await fetch(TOKEN_INFO_URL, { headers })
    if (!res.ok) {
      log.warn(`allbridge token-info ${res.status}`)
      return undefined
    }
    response = (await res.json()) as AllbridgeApiResponse
    cached = { value: response, expiresAt: now + CACHE_TTL_MS }
  }

  const symbol = NETWORK_ID_TO_ALLBRIDGE_BLOCKCHAIN_SYMBOL[networkId]
  return symbol ? response[symbol] : undefined
}
