// Ported from valora-inc/hooks (Apache-2.0).
// Inspired by https://github.com/valora-inc/hooks/blob/main/src/apps/allbridge/positions.e2e.ts
// License: Apache-2.0 - see LICENSE-ALLBRIDGE.md at repo root.
//
// Tests use a hand-built mock viem PublicClient injected via
// `__setCeloPublicClientForTests`. The Allbridge REST API is mocked at
// the `getAllbridgeTokenInfo` boundary so no network is required.

import type { Address } from 'viem'
import { clearAllbridgeApiCache } from './api'
import { getPositions, getTokenId, getRewardPositionId } from './positions'
import { __setCeloPublicClientForTests } from './rpc'
import type { AppTokenPosition, ContractPosition } from './types'

// Fixture wallet from upstream's positions.e2e.ts (kept in full to avoid
// any chance of address truncation/collision).
const FIXTURE_WALLET = '0x2222222222222222222222222222222222222222'
// Allbridge Celo pool address (verified on Celoscan).
const POOL_ADDRESS_LOWER = '0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af'
const POOL_ADDRESS_CHECKSUM = '0xfb2C7c10e731EBe96Dabdf4A96D656Bfe8e2b5Af'
// USDC on Celo.
const USDC_LOWER = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const USDC_CHECKSUM = '0xceBA9300f2b948710d2653dD7B07f33A8B32118C'

jest.mock('./api', () => {
  const actual = jest.requireActual('./api')
  return {
    ...actual,
    getAllbridgeTokenInfo: jest.fn(async () => ({
      tokens: [
        {
          name: 'USDC',
          poolAddress: POOL_ADDRESS_CHECKSUM,
          tokenAddress: USDC_CHECKSUM,
          decimals: 6,
          symbol: 'USDC',
          poolInfo: {
            aValue: '20',
            dValue: '0',
            tokenBalance: '0',
            vUsdBalance: '0',
            totalLpAmount: '0',
            accRewardPerShareP: '0',
            p: 52,
          },
          feeShare: '0.0015',
          apr: '0.05',
          apr7d: '0.04',
          apr30d: '0.045',
          lpRate: '1',
        },
      ],
      chainId: 42220,
      bridgeAddress: '0x0000000000000000000000000000000000000000',
      swapAddress: '0x0000000000000000000000000000000000000000',
      transferTime: {},
      confirmations: 1,
      txCostAmount: { swap: '0', transfer: '0', maxAmount: '0' },
    })),
    clearAllbridgeApiCache: actual.clearAllbridgeApiCache,
  }
})

interface ReadCall {
  address: Address
  functionName: string
}

function buildMockClient(
  fakeReads: (call: ReadCall) => unknown,
): { readContract: jest.Mock } {
  return {
    readContract: jest.fn(async (call: ReadCall) => fakeReads(call)),
  }
}

describe('allbridge positions', () => {
  beforeEach(() => {
    clearAllbridgeApiCache()
    __setCeloPublicClientForTests(null)
  })

  it('emits an AppTokenPosition with non-zero LP balance and a reward ContractPosition', async () => {
    const lpDecimals = 3
    const lpBalance = 1_234_567n
    const totalSupply = 9_999_888n
    const pendingReward = 250_000n

    const mockClient = buildMockClient((call) => {
      switch (call.functionName) {
        case 'balanceOf':
          return lpBalance
        case 'pendingReward':
          return pendingReward
        case 'totalSupply':
          return totalSupply
        case 'decimals':
          return lpDecimals
        default:
          throw new Error(`unexpected read: ${call.functionName}`)
      }
    })
    __setCeloPublicClientForTests(mockClient as unknown as Parameters<typeof __setCeloPublicClientForTests>[0])

    const positions = await getPositions({
      networkId: 'celo-mainnet',
      address: FIXTURE_WALLET,
    })

    expect(positions).toHaveLength(2)

    const lp = positions[0] as AppTokenPosition
    expect(lp.type).toBe('app-token')
    expect(lp.appId).toBe('allbridge')
    expect(lp.appName).toBe('Allbridge')
    expect(lp.networkId).toBe('celo-mainnet')

    // PARITY: positionId for app-token-definition == tokenId of the pool.
    expect(lp.positionId).toBe(`celo-mainnet:${POOL_ADDRESS_LOWER}`)
    expect(lp.address).toBe(POOL_ADDRESS_LOWER)

    expect(lp.availableShortcutIds).toEqual(['deposit', 'withdraw'])
    // PARITY: shortcutTriggerArgs keys + field names must match what the
    // wallet sends in prepareTransactions.ts.
    expect(lp.shortcutTriggerArgs).toEqual({
      deposit: {
        tokenAddress: USDC_LOWER,
        tokenDecimals: 6,
        positionAddress: POOL_ADDRESS_LOWER,
      },
      withdraw: {
        tokenDecimals: lpDecimals,
        positionAddress: POOL_ADDRESS_LOWER,
      },
      'swap-deposit': {
        tokenAddress: USDC_LOWER,
        positionAddress: POOL_ADDRESS_LOWER,
      },
    })

    // PARITY: depositTokenId / withdrawTokenId format.
    expect(lp.dataProps?.depositTokenId).toBe(`celo-mainnet:${USDC_LOWER}`)
    expect(lp.dataProps?.withdrawTokenId).toBe(`celo-mainnet:${POOL_ADDRESS_LOWER}`)
    expect(lp.dataProps?.termsUrl).toBe(
      'https://allbridge.io/assets/docs/Allbridge%20-%20Terms%20and%20Conditions.pdf',
    )
    expect(lp.dataProps?.contractCreatedAt).toBe('2024-05-08T09:09:55.000Z')

    // 1_234_567 wei at lpDecimals=3 -> "1234.567"
    expect(lp.balance).toBe('1234.567')
    expect(lp.supply).toBe('9999.888')
    expect(lp.pricePerShare).toEqual(['1'])
    expect(lp.tokens).toHaveLength(1)
    expect(lp.tokens[0]).toMatchObject({
      type: 'base-token',
      tokenId: `celo-mainnet:${USDC_LOWER}`,
      address: USDC_LOWER,
      symbol: 'USDC',
      decimals: 6,
    })

    expect(lp.dataProps?.earningItems).toEqual([
      {
        amount: '0.25',
        label: 'Earnings',
        tokenId: `celo-mainnet:${USDC_LOWER}`,
      },
    ])
    expect(lp.dataProps?.rewardsPositionIds).toEqual([
      `celo-mainnet:${POOL_ADDRESS_LOWER}:supply-incentives`,
    ])

    const reward = positions[1] as ContractPosition
    expect(reward.type).toBe('contract-position')
    expect(reward.positionId).toBe(
      `celo-mainnet:${POOL_ADDRESS_LOWER}:supply-incentives`,
    )
    expect(reward.availableShortcutIds).toEqual(['claim-rewards'])
    expect(reward.shortcutTriggerArgs).toEqual({
      'claim-rewards': { positionAddress: POOL_ADDRESS_LOWER },
    })
    expect(reward.tokens[0]).toMatchObject({
      type: 'base-token',
      tokenId: `celo-mainnet:${USDC_LOWER}`,
      address: USDC_LOWER,
      category: 'claimable',
      balance: '0.25',
    })
  })

  it('omits the LP position when no address provided is wrong - emits LP with zero balance', async () => {
    const mockClient = buildMockClient((call) => {
      switch (call.functionName) {
        case 'totalSupply':
          return 1_000_000n
        case 'decimals':
          return 6
        default:
          throw new Error(`unexpected read: ${call.functionName}`)
      }
    })
    __setCeloPublicClientForTests(mockClient as unknown as Parameters<typeof __setCeloPublicClientForTests>[0])

    const positions = await getPositions({ networkId: 'celo-mainnet' })
    // Without `address` we always emit the LP catalogue entry (so the
    // wallet can list available pools) but no reward position.
    expect(positions).toHaveLength(1)
    const lp = positions[0] as AppTokenPosition
    expect(lp.type).toBe('app-token')
    expect(lp.balance).toBe('0')
    expect(lp.tokens[0]?.balance).toBe('0')
  })

  it('omits the LP entry when the user has zero balance and zero rewards', async () => {
    const mockClient = buildMockClient((call) => {
      switch (call.functionName) {
        case 'balanceOf':
          return 0n
        case 'pendingReward':
          return 0n
        case 'totalSupply':
          return 1_000n
        case 'decimals':
          return 6
        default:
          throw new Error(`unexpected read: ${call.functionName}`)
      }
    })
    __setCeloPublicClientForTests(mockClient as unknown as Parameters<typeof __setCeloPublicClientForTests>[0])

    const positions = await getPositions({
      networkId: 'celo-mainnet',
      address: FIXTURE_WALLET,
    })
    expect(positions).toHaveLength(0)
  })

  it('snapshot of full position shape (regression guard for parity)', async () => {
    const mockClient = buildMockClient((call) => {
      switch (call.functionName) {
        case 'balanceOf':
          return 5_000_000n
        case 'pendingReward':
          return 0n
        case 'totalSupply':
          return 10_000_000n
        case 'decimals':
          return 6
        default:
          throw new Error(`unexpected read: ${call.functionName}`)
      }
    })
    __setCeloPublicClientForTests(mockClient as unknown as Parameters<typeof __setCeloPublicClientForTests>[0])

    const positions = await getPositions({
      networkId: 'celo-mainnet',
      address: FIXTURE_WALLET,
    })
    expect(positions).toMatchSnapshot()
  })

  it('tokenId / positionId helpers match upstream byte-for-byte', () => {
    expect(getTokenId({ networkId: 'celo-mainnet', address: POOL_ADDRESS_CHECKSUM })).toBe(
      `celo-mainnet:${POOL_ADDRESS_LOWER}`,
    )
    expect(
      getRewardPositionId({
        networkId: 'celo-mainnet',
        poolAddress: POOL_ADDRESS_CHECKSUM,
      }),
    ).toBe(`celo-mainnet:${POOL_ADDRESS_LOWER}:supply-incentives`)
  })
})
