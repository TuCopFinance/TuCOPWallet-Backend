// Ported from valora-inc/hooks (Apache-2.0).
// Original: https://github.com/valora-inc/hooks/blob/main/src/apps/allbridge/positions.ts
// License: Apache-2.0 - see LICENSE-ALLBRIDGE.md at repo root.
//
// Differences vs upstream:
//
// - Upstream returns "definitions" that a runtime resolves into the final
//   `Position` shape (symbol/decimals/priceUsd/tokenId resolution, BigNumber
//   conversion). This backend has no such runtime - PR 4 wires the HTTP
//   layer and can layer token-info resolution on top. To keep the public
//   shape exactly the one the wallet expects, this file emits final
//   `AppTokenPosition` and `ContractPosition` JSON directly, with token
//   `symbol`/`decimals` from the Allbridge API and `priceUsd` defaulted
//   to "0" (PR 4 can populate it from the wallet's token-info service).
//
// - `BigNumber.js` dependency dropped. APR is computed with Number; same
//   precision loss the upstream display path already tolerates.
//
// - `t()` (i18next) dependency dropped. Yield-rate label is hardcoded to
//   the English string upstream emits via `t('yieldRates.earningsApr')`,
//   matching the value that ships in Valora's mainnet response today.
//
// - `tokenId`/`positionId` format preserved BYTE-FOR-BYTE:
//     tokenId    = `${networkId}:${address.toLowerCase()}`
//     positionId = same as the position's tokenId for app-token-definition
//                  (per upstream `getPositionId.ts`).
//     reward     = `${networkId}:${address.toLowerCase()}:supply-incentives`
//
// - `shortcutTriggerArgs` shape is preserved verbatim - the wallet's
//   `src/earn/prepareTransactions.ts` keys off these field names.

import type { Address } from 'viem'
import { createLogger } from '../../lib/logger'
import { APP_ID, APP_NAME } from './manifest'
import { getAllbridgeTokenInfo, type TokenInfo } from './api'
import { poolAbi } from './abis/pool'
import {
  ALLBRIDGE_CONTRACT_CREATED_AT,
  ALLBRIDGE_LOGO,
  ALLBRIDGE_POOLS_BASE_URL,
  ALLBRIDGE_TERMS_URL,
  NETWORK_ID_TO_ALLBRIDGE_CHAIN,
} from './constants'
import { getCeloPublicClient } from './rpc'
import {
  ClaimType,
  type AppTokenPosition,
  type ContractPosition,
  type NetworkId,
  type Position,
  type SerializedDecimalNumber,
} from './types'

const log = createLogger('app:allbridge:positions')

// Matches upstream's i18n key `yieldRates.earningsApr` (English value as
// shipped in Valora's mainnet response today).
const YIELD_RATE_LABEL = 'Earnings APR'
const EARNING_ITEM_LABEL = 'Earnings'

export function getTokenId(args: { networkId: NetworkId; address: string }): string {
  return `${args.networkId}:${args.address.toLowerCase()}`
}

export function getRewardPositionId(args: {
  networkId: NetworkId
  poolAddress: string
}): string {
  // Mirrors upstream `getPositionId.ts` for contract-position-definition:
  // `${tokenId}:${extraId}`. extraId for Allbridge rewards = 'supply-incentives'.
  return `${getTokenId({ networkId: args.networkId, address: args.poolAddress })}:supply-incentives`
}

function toDecimalString(value: bigint, decimals: number): SerializedDecimalNumber {
  // Render a wei-style bigint as a decimal string with `decimals` places,
  // trimmed of trailing zeroes. Mirrors upstream's
  // `toSerializedDecimalNumber(toDecimalNumber(value, decimals))`.
  if (decimals === 0) return value.toString()
  const negative = value < 0n
  const abs = negative ? -value : value
  const asStr = abs.toString().padStart(decimals + 1, '0')
  const whole = asStr.slice(0, asStr.length - decimals)
  const frac = asStr.slice(asStr.length - decimals).replace(/0+$/, '')
  const out = frac.length === 0 ? whole : `${whole}.${frac}`
  return negative ? `-${out}` : out
}

function computeAprPercent(apr7d: string): number {
  // Upstream: `new BigNumber(tokenInfo.apr7d).toNumber() * 100`. APR is
  // a display number, Number-precision is fine here.
  const n = Number(apr7d)
  if (!Number.isFinite(n)) return 0
  return n * 100
}

interface ReadResults {
  balance?: bigint
  pendingReward?: bigint
  totalSupply: bigint
  lpDecimals: number
}

async function readPoolMetrics(
  tokenInfo: TokenInfo,
  address: string | undefined,
): Promise<ReadResults> {
  const client = getCeloPublicClient()
  const pool: Address = tokenInfo.poolAddress

  const reads = await Promise.all([
    address
      ? client.readContract({
          address: pool,
          abi: poolAbi,
          functionName: 'balanceOf',
          args: [address as Address],
        })
      : Promise.resolve(undefined),
    address
      ? client.readContract({
          address: pool,
          abi: poolAbi,
          functionName: 'pendingReward',
          args: [address as Address],
        })
      : Promise.resolve(undefined),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'totalSupply',
      args: [],
    }),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'decimals',
      args: [],
    }),
  ])

  return {
    balance: reads[0] as bigint | undefined,
    pendingReward: reads[1] as bigint | undefined,
    totalSupply: reads[2] as bigint,
    lpDecimals: Number(reads[3] as number),
  }
}

function buildRewardPosition(
  networkId: NetworkId,
  tokenInfo: TokenInfo,
  pendingReward: bigint,
): ContractPosition {
  const poolAddr = tokenInfo.poolAddress.toLowerCase()
  const tokenAddr = tokenInfo.tokenAddress.toLowerCase()
  const manageUrl = `${ALLBRIDGE_POOLS_BASE_URL}?chain=${NETWORK_ID_TO_ALLBRIDGE_CHAIN[networkId]}`

  const claimableBalance = toDecimalString(pendingReward, tokenInfo.decimals)

  return {
    type: 'contract-position',
    positionId: getRewardPositionId({ networkId, poolAddress: poolAddr }),
    address: poolAddr,
    networkId,
    appId: APP_ID,
    appName: APP_NAME,
    label: `${tokenInfo.symbol} supply incentives`,
    displayProps: {
      title: `${tokenInfo.symbol} supply incentives`,
      description: 'Rewards for supplying',
      imageUrl: ALLBRIDGE_LOGO,
      manageUrl,
    },
    tokens: [
      {
        type: 'base-token',
        tokenId: getTokenId({ networkId, address: tokenAddr }),
        address: tokenAddr,
        networkId,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        priceUsd: '0',
        balance: claimableBalance,
        category: 'claimable',
      },
    ],
    availableShortcutIds: ['claim-rewards'],
    shortcutTriggerArgs: {
      'claim-rewards': {
        positionAddress: poolAddr,
      },
    },
    balanceUsd: '0',
  }
}

function buildLpPosition(
  networkId: NetworkId,
  tokenInfo: TokenInfo,
  metrics: ReadResults,
  rewardPositionId: string | undefined,
): AppTokenPosition {
  const poolAddr = tokenInfo.poolAddress.toLowerCase()
  const tokenAddr = tokenInfo.tokenAddress.toLowerCase()
  const poolTokenId = getTokenId({ networkId, address: poolAddr })
  const underlyingTokenId = getTokenId({ networkId, address: tokenAddr })
  const manageUrl = `${ALLBRIDGE_POOLS_BASE_URL}?chain=${NETWORK_ID_TO_ALLBRIDGE_CHAIN[networkId]}`

  const apr = computeAprPercent(tokenInfo.apr7d)
  const lpDecimals = metrics.lpDecimals
  const lpBalance =
    metrics.balance !== undefined
      ? toDecimalString(metrics.balance, lpDecimals)
      : '0'
  const tvl = toDecimalString(metrics.totalSupply, lpDecimals)

  const earningItems =
    metrics.pendingReward !== undefined && metrics.pendingReward > 0n
      ? [
          {
            amount: toDecimalString(metrics.pendingReward, tokenInfo.decimals),
            label: EARNING_ITEM_LABEL,
            tokenId: underlyingTokenId,
          },
        ]
      : []

  return {
    type: 'app-token',
    positionId: poolTokenId, // upstream `getPositionId` for app-token-definition = tokenId
    address: poolAddr,
    networkId,
    appId: APP_ID,
    appName: APP_NAME,
    label: tokenInfo.symbol,
    displayProps: {
      title: tokenInfo.symbol,
      description: `Supplied (APR: ${apr.toFixed(2)}%)`,
      imageUrl: ALLBRIDGE_LOGO,
      manageUrl,
    },
    dataProps: {
      manageUrl,
      claimType: ClaimType.Earnings,
      withdrawalIncludesClaim: true,
      termsUrl: ALLBRIDGE_TERMS_URL,
      contractCreatedAt: ALLBRIDGE_CONTRACT_CREATED_AT[poolTokenId],
      tvl,
      yieldRates: [
        {
          percentage: apr,
          label: YIELD_RATE_LABEL,
          tokenId: underlyingTokenId,
        },
      ],
      earningItems,
      depositTokenId: underlyingTokenId,
      withdrawTokenId: poolTokenId,
      rewardsPositionIds: rewardPositionId ? [rewardPositionId] : [],
    },
    tokens: [
      {
        type: 'base-token',
        tokenId: underlyingTokenId,
        address: tokenAddr,
        networkId,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        priceUsd: '0',
        balance: '0',
      },
    ],
    availableShortcutIds: ['deposit', 'withdraw'],
    shortcutTriggerArgs: {
      deposit: {
        tokenAddress: tokenAddr,
        tokenDecimals: tokenInfo.decimals,
        positionAddress: poolAddr,
      },
      withdraw: {
        tokenDecimals: lpDecimals,
        positionAddress: poolAddr,
      },
      'swap-deposit': {
        tokenAddress: tokenAddr,
        positionAddress: poolAddr,
      },
    },
    symbol: tokenInfo.symbol,
    decimals: lpDecimals,
    priceUsd: '0',
    balance: lpBalance,
    supply: tvl,
    pricePerShare: ['1'],
  }
}

export interface GetPositionsArgs {
  networkId: NetworkId
  address?: string
}

export async function getPositions({
  networkId,
  address,
}: GetPositionsArgs): Promise<Position[]> {
  const tokenInfos = (await getAllbridgeTokenInfo({ networkId }))?.tokens
  if (!tokenInfos) return []

  const metricsList = await Promise.all(
    tokenInfos.map(async (tokenInfo) => {
      try {
        return await readPoolMetrics(tokenInfo, address)
      } catch (err) {
        log.warn(
          `pool read failed for ${tokenInfo.poolAddress}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return null
      }
    }),
  )

  const out: Position[] = []
  for (let i = 0; i < tokenInfos.length; i++) {
    const tokenInfo = tokenInfos[i]
    const metrics = metricsList[i]
    if (!tokenInfo || !metrics) continue

    const hasBalance = metrics.balance !== undefined && metrics.balance > 0n
    const hasReward = metrics.pendingReward !== undefined && metrics.pendingReward > 0n
    const showLp = !address || hasBalance

    let rewardPositionId: string | undefined
    let rewardPosition: ContractPosition | undefined
    if (hasReward && metrics.pendingReward !== undefined) {
      rewardPosition = buildRewardPosition(networkId, tokenInfo, metrics.pendingReward)
      rewardPositionId = rewardPosition.positionId
    }

    if (showLp) {
      out.push(buildLpPosition(networkId, tokenInfo, metrics, rewardPositionId))
    }
    if (rewardPosition) {
      out.push(rewardPosition)
    }
  }

  return out
}
