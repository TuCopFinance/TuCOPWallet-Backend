// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Squid quote proxy"
// documents the /api/swap/quote fallback behavior that consumes this module.
//
// Uniswap V4 Quoter integration for the USDT<->COPm pair only. Used as a
// fallback / comparison for the Squid quote proxy when Mento suspends
// USDT<->COPm trading on weekends (documented failure: Squid returns
// HTTP 502 "squid upstream unavailable" for the pair while non-Mento
// pairs work normally).
//
// Scope on 2026-08-09: quote-side only (Fase 1). Execute-side (Permit2
// signature + UniversalRouter calldata) lands in a follow-up PR.
//
// Design:
//   - `getUniswapV4Quote(direction, exactAmount)` calls the V4Quoter's
//     `quoteExactInputSingle` view-ish function via viem simulateContract.
//   - Uses the shared Celo RPC fallback chain (getSharedCeloFallbackExecutor)
//     so an RPC provider going down does not silently break Uniswap-side
//     quoting.
//   - PoolKey values are hardcoded because the USDT/COPm pool params are
//     immutable per Uniswap V4 design (identity of the pool). Values were
//     given by the wallet team on 2026-08-09.

import type { PublicClient } from 'viem'
import { getSharedCeloFallbackExecutor } from './celoRpcFallback'
import { createLogger } from './logger'

const log = createLogger('lib:uniswap-v4')

// V4Quoter deployed on Celo mainnet (per docs.uniswap.org deployments page).
export const V4_QUOTER_ADDRESS =
  '0x28566da1093609182dff2cb2a91cfd72e61d66cd' as `0x${string}`

// PoolKey for the USDT/COPm pool. currency0 must be the address that sorts
// lower numerically (USDT 0x48065... < COPm 0x8a567...). Values verified
// against the on-chain pool by the wallet team on 2026-08-09.
export const POOL_USDT_COPM = {
  currency0: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e' as `0x${string}`, // USDT (6 decimals)
  currency1: '0x8a567e2ae79ca692bd748ab832081c45de4041ea' as `0x${string}`, // COPm (18 decimals)
  fee: 100, // 0.01%
  tickSpacing: 1,
  hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`, // hookless
} as const

// Direction. `USDT_TO_COPM` is zeroForOne=true (sell currency0). `COPM_TO_USDT`
// is zeroForOne=false. Callers pass this rather than raw booleans so the
// call site is readable at grep-time.
export type UniswapV4Direction = 'USDT_TO_COPM' | 'COPM_TO_USDT'

// Minimal ABI slice needed for quoteExactInputSingle. Extracted from the
// V4Quoter interface at github.com/Uniswap/v4-periphery. The function is
// marked nonpayable (not view) because it mutates transient state, but is
// invoked via eth_call which reverts with the encoded return, so viem's
// simulateContract handles it transparently.
const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const

export interface UniswapV4QuoteResult {
  amountOut: bigint
  gasEstimate: bigint
}

// Returns null when the Quoter reverts (pool has no liquidity for the size,
// tick out of range, etc.). Callers must treat null as "Uniswap could not
// price this trade" and fall back to whatever else is in play. Any other
// error (RPC failure across the entire fallback chain) throws so it
// surfaces in logs. Absent-liquidity != "we broke".
export async function getUniswapV4Quote(
  direction: UniswapV4Direction,
  exactAmount: bigint,
): Promise<UniswapV4QuoteResult | null> {
  const zeroForOne = direction === 'USDT_TO_COPM'
  const executor = getSharedCeloFallbackExecutor()
  try {
    const [amountOut, gasEstimate] = await executor.withFallback(
      'uniswapV4:quoteExactInputSingle',
      async (client: PublicClient) => {
        const sim = await client.simulateContract({
          address: V4_QUOTER_ADDRESS,
          abi: V4_QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              poolKey: POOL_USDT_COPM,
              zeroForOne,
              exactAmount,
              hookData: '0x' as `0x${string}`,
            },
          ],
        })
        return sim.result as readonly [bigint, bigint]
      },
    )
    return { amountOut, gasEstimate }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Distinguish "pool cannot price" (revert with reason) from "RPC layer
    // exploded" (network error). The former is expected and returns null;
    // the latter would be a real bug worth surfacing. viem wraps reverts
    // as ContractFunctionExecutionError with the revert reason in the
    // message; we treat any message that looks like a revert as "no price
    // available" and everything else as a real failure to be logged loud.
    if (/reverted|Revert|execution reverted/i.test(msg)) {
      log.warn(
        `V4Quoter reverted for ${direction} exactAmount=${exactAmount.toString()}: ${msg.slice(0, 200)}`,
      )
      return null
    }
    log.error(
      `V4Quoter unexpected error for ${direction} exactAmount=${exactAmount.toString()}: ${msg.slice(0, 200)}`,
    )
    throw err
  }
}

// Detects whether the given token pair is the USDT<->COPm pair this
// module supports. Comparisons are case-insensitive; callers are expected
// to pass 0x-prefixed 40-hex addresses (any case).
export function isUsdtCopmPair(
  sellToken: string,
  buyToken: string,
): UniswapV4Direction | null {
  const sell = sellToken.toLowerCase()
  const buy = buyToken.toLowerCase()
  if (sell === POOL_USDT_COPM.currency0 && buy === POOL_USDT_COPM.currency1) {
    return 'USDT_TO_COPM'
  }
  if (sell === POOL_USDT_COPM.currency1 && buy === POOL_USDT_COPM.currency0) {
    return 'COPM_TO_USDT'
  }
  return null
}
