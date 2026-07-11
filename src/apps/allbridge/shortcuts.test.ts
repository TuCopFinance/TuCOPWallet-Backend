// Ported from valora-inc/hooks (Apache-2.0).
// License: Apache-2.0 - see LICENSES/allbridge.md at repo root.
//
// Selector decoding uses viem's `toFunctionSelector` to derive the
// expected 4-byte signature for each function name and compares against
// `data.slice(0, 10)`.

import { toFunctionSelector, type Address } from 'viem'
import { __setCeloPublicClientForTests } from './rpc'
import {
  getShortcuts,
  triggerClaimRewards,
  triggerDeposit,
  triggerWithdraw,
} from './shortcuts'

const USER: Address = '0x2222222222222222222222222222222222222222'
const POOL: Address = '0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af'
const USDC: Address = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x[0-9a-fA-F]*$/

const APPROVE_SELECTOR = toFunctionSelector('approve(address,uint256)')
const DEPOSIT_SELECTOR = toFunctionSelector('deposit(uint256)')
const WITHDRAW_SELECTOR = toFunctionSelector('withdraw(uint256)')
const CLAIM_REWARDS_SELECTOR = toFunctionSelector('claimRewards()')

function assertValidTx(tx: { to: string; data: string; value: string; networkId: string }): void {
  expect(tx.to).toMatch(ADDRESS_RE)
  expect(tx.data).toMatch(HEX_RE)
  expect(tx.value).toMatch(/^\d+$/) // "0" or any unsigned decimal int string
  expect(tx.networkId).toBe('celo-mainnet')
}

describe('allbridge shortcuts', () => {
  beforeEach(() => {
    __setCeloPublicClientForTests(null)
  })

  describe('getShortcuts', () => {
    it('returns the 4 expected shortcut definitions with appId=allbridge', () => {
      const shortcuts = getShortcuts()
      expect(shortcuts).toHaveLength(4)
      const ids = shortcuts.map((s) => s.id).sort()
      expect(ids).toEqual(['claim-rewards', 'deposit', 'swap-deposit', 'withdraw'])
      for (const s of shortcuts) {
        expect(s.appId).toBe('allbridge')
        expect(s.networkIds).toEqual(['celo-mainnet'])
      }
    })

    it('returns a fresh array each call (no shared mutable state)', () => {
      const a = getShortcuts()
      const b = getShortcuts()
      a[0]!.name = 'tampered'
      expect(b[0]!.name).not.toBe('tampered')
    })
  })

  describe('triggerDeposit', () => {
    it('emits [approve, deposit] when allowance < amount', async () => {
      __setCeloPublicClientForTests({
        readContract: jest.fn(async () => 0n),
      } as unknown as Parameters<typeof __setCeloPublicClientForTests>[0])

      const result = await triggerDeposit({
        address: USER,
        networkId: 'celo-mainnet',
        positionAddress: POOL,
        tokenAddress: USDC,
        tokenDecimals: 6,
        tokens: [{ amount: '100' }],
      })

      expect(result.transactions).toHaveLength(2)
      const [approveTx, depositTx] = result.transactions
      assertValidTx(approveTx!)
      assertValidTx(depositTx!)

      expect(approveTx!.to).toBe(USDC)
      expect(approveTx!.data.slice(0, 10)).toBe(APPROVE_SELECTOR)

      expect(depositTx!.to).toBe(POOL)
      expect(depositTx!.data.slice(0, 10)).toBe(DEPOSIT_SELECTOR)
    })

    it('skips approve when allowance already covers the amount', async () => {
      __setCeloPublicClientForTests({
        readContract: jest.fn(async () => 10n ** 30n), // huge
      } as unknown as Parameters<typeof __setCeloPublicClientForTests>[0])

      const result = await triggerDeposit({
        address: USER,
        networkId: 'celo-mainnet',
        positionAddress: POOL,
        tokenAddress: USDC,
        tokenDecimals: 6,
        tokens: [{ amount: '100' }],
      })

      expect(result.transactions).toHaveLength(1)
      const [depositTx] = result.transactions
      assertValidTx(depositTx!)
      expect(depositTx!.to).toBe(POOL)
      expect(depositTx!.data.slice(0, 10)).toBe(DEPOSIT_SELECTOR)
    })

    it('rejects tokens with length != 1', async () => {
      __setCeloPublicClientForTests({
        readContract: jest.fn(async () => 0n),
      } as unknown as Parameters<typeof __setCeloPublicClientForTests>[0])

      await expect(
        triggerDeposit({
          address: USER,
          networkId: 'celo-mainnet',
          positionAddress: POOL,
          tokenAddress: USDC,
          tokenDecimals: 6,
          tokens: [],
        }),
      ).rejects.toThrow('tokens must have length 1')
    })
  })

  describe('triggerWithdraw', () => {
    it('emits a single withdraw tx to the pool', async () => {
      const result = await triggerWithdraw({
        address: USER,
        networkId: 'celo-mainnet',
        positionAddress: POOL,
        tokenDecimals: 3,
        tokens: [{ amount: '1.5' }],
      })

      expect(result.transactions).toHaveLength(1)
      const [withdrawTx] = result.transactions
      assertValidTx(withdrawTx!)
      expect(withdrawTx!.to).toBe(POOL)
      expect(withdrawTx!.data.slice(0, 10)).toBe(WITHDRAW_SELECTOR)
    })
  })

  describe('triggerClaimRewards', () => {
    it('emits a single claimRewards tx to the pool', async () => {
      const result = await triggerClaimRewards({
        address: USER,
        networkId: 'celo-mainnet',
        positionAddress: POOL,
      })

      expect(result.transactions).toHaveLength(1)
      const [claimTx] = result.transactions
      assertValidTx(claimTx!)
      expect(claimTx!.to).toBe(POOL)
      expect(claimTx!.data.slice(0, 10)).toBe(CLAIM_REWARDS_SELECTOR)
      // claimRewards() has no args, so the calldata is exactly the selector.
      expect(claimTx!.data).toBe(CLAIM_REWARDS_SELECTOR)
    })
  })
})
