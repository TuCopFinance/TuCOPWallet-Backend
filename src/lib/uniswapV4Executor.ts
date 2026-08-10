// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Uniswap V4
// fallback" documents the wallet-side integration for the Permit2 signing +
// UniversalRouter execute flow this module powers.
//
// Uniswap V4 execute-side helpers for the USDT<->COPm pair. Complements
// `uniswapV4.ts` (Quoter, pool descriptor, direction detection) with the
// Permit2 signing flow + UniversalRouter calldata builder.
//
// Wire flow (walletbackend):
//
//   1. Wallet calls GET /api/swap/quote for USDT<->COPm.
//   2. When SWAP_FALLBACK_UNISWAP_V4_ACTIVE=true AND Uniswap wins price OR
//      Squid returns an upstream error, the response carries
//      `swapProvider: "uniswap-v4"` plus a `permit2` field containing:
//        - the EIP-712 typed data to sign (Permit2.PermitSingle)
//        - the fresh nonce and expiration values the backend read from
//          Permit2 for this (user, token, UniversalRouter) triple.
//      Wallet signs via eth_signTypedData_v4.
//   3. Wallet POSTs the signature back to /api/swap/build-tx along with the
//      original quote params. Backend re-validates + constructs the final
//      UniversalRouter.execute() calldata with the user's signature spliced
//      in server-side, returns `{ to, data, value }`.
//   4. Wallet submits eth_sendTransaction with the returned tx object.
//
// This module ONLY builds calldata + typed data. Endpoint wiring is in
// src/routes/swap.ts. Everything gated behind SWAP_FALLBACK_UNISWAP_V4_ACTIVE.
//
// Contract addresses verified against:
//   - Uniswap SDK addresses.ts (github.com/Uniswap/sdks) 2026-08-09
//   - Uniswap universal-router deploy-addresses/celo.json 2026-08-09
//   - Celoscan source verification for the v2.1.1 router on Celo
// Command + Action byte values verified against the same v2.1.1 UniversalRouter
// source on Celoscan (Commands.sol, V4Router.sol, Actions.sol).

import {
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  isHex,
  type PublicClient,
} from 'viem'
import { getSharedCeloFallbackExecutor } from './celoRpcFallback'
import { createLogger } from './logger'
import { POOL_USDT_COPM, type UniswapV4Direction } from './uniswapV4'

const log = createLogger('lib:uniswap-v4-executor')

// UniversalRouter v2.1.1 with V4_SWAP support, deployed on Celo mainnet.
// The older `0x643770...` on Celo is v1.2 (no V4). Verified as
// `UniversalRouterV2_1_1` in Uniswap's `universal-router` deploy-addresses.
export const UNIVERSAL_ROUTER_ADDRESS =
  '0x8b844f885672f333bc0042cb669255f93a4c1e6b' as `0x${string}`

// Canonical Permit2 deployment. Same address on every EVM chain (CREATE2).
export const PERMIT2_ADDRESS =
  '0x000000000022d473030f116ddee9f6b43ac78ba3' as `0x${string}`

// Celo chain id, needed for the EIP-712 domain.
export const CELO_CHAIN_ID = 42220

// UniversalRouter command bytes (from Commands.sol on v2.1.1 source).
const CMD_PERMIT2_PERMIT = 0x0a
const CMD_V4_SWAP = 0x10

// V4 Router action bytes (from v4-periphery Actions.sol).
const ACT_SWAP_EXACT_IN_SINGLE = 0x06
const ACT_SETTLE_ALL = 0x0c
const ACT_TAKE_ALL = 0x0f
const ACT_TAKE_PORTION = 0x10

// Integrator fee on Uniswap V4 output, in bips. 50 = 0.5%. Matches the
// SQUID_INTEGRATOR_FEE_PERCENTAGE convention (0.5% total to user, ~half to
// integrator). The Uniswap path routes the full 50 bps to the integrator
// address (no split with the router). Env-driven; falls back to 50 if unset.
function getIntegratorFeeBips(): number {
  const raw = process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE
  const parsed = raw ? Number(raw) : NaN
  // Squid uses "0.5" for 0.5%; Uniswap TAKE_PORTION uses bips (50 for 0.5%).
  // Multiply by 100 to convert (0.5% -> 50 bips). Clamp to [1, 500] as a
  // sanity guard; a misconfigured value should not empty the trade.
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  const bips = Math.round(parsed * 100)
  if (bips < 1 || bips > 500) return 50
  return bips
}

// Fee recipient. Reused from the Squid integrator env so both routing paths
// deposit fees into the same address for reconciliation. Returns null when
// unset, in which case the executor skips the TAKE_PORTION action and the
// user receives the full output (no fee collected on Uniswap side either).
function getFeeRecipient(): `0x${string}` | null {
  const raw = process.env.SQUID_INTEGRATOR_FEE_ADDRESS
  if (!raw) return null
  if (!isHex(raw) || raw.length !== 42) return null
  return raw.toLowerCase() as `0x${string}`
}

// -----------------------------------------------------------------------
// Permit2 allowance read
// -----------------------------------------------------------------------

export interface Permit2AllowanceInfo {
  // Existing remaining allowance amount (uint160). If > sellAmount and not
  // expired, the wallet does NOT need to sign a new permit; the swap can
  // proceed with just SETTLE_ALL. The backend still returns typed data so
  // the wallet has the option; wallets can skip signing when they detect
  // sufficient existing allowance.
  amount: bigint
  // Unix seconds when the existing allowance expires (uint48). Zero when
  // no allowance exists.
  expiration: number
  // The nonce the user should include in their next PermitSingle signature
  // (uint48). Increments after every successful PERMIT2_PERMIT call.
  nonce: number
}

const PERMIT2_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
] as const

export async function getPermit2AllowanceInfo(
  user: `0x${string}`,
  token: `0x${string}`,
  spender: `0x${string}` = UNIVERSAL_ROUTER_ADDRESS,
): Promise<Permit2AllowanceInfo> {
  const executor = getSharedCeloFallbackExecutor()
  const [amount, expiration, nonce] = await executor.withFallback(
    'permit2:allowance',
    async (client: PublicClient) => {
      const result = (await client.readContract({
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: 'allowance',
        args: [user, token, spender],
      })) as readonly [bigint, number, number]
      return result
    },
  )
  return { amount, expiration, nonce }
}

// -----------------------------------------------------------------------
// EIP-712 typed data for Permit2.PermitSingle
// -----------------------------------------------------------------------

// Match the EIP-712 shape defined in permit2/src/interfaces/IAllowanceTransfer.sol
// and permit2/src/libraries/PermitHash.sol. The wallet must sign this exact
// structure via eth_signTypedData_v4.
export interface Permit2TypedData {
  domain: {
    name: 'Permit2'
    chainId: number
    verifyingContract: `0x${string}`
  }
  types: {
    PermitDetails: [
      { name: 'token'; type: 'address' },
      { name: 'amount'; type: 'uint160' },
      { name: 'expiration'; type: 'uint48' },
      { name: 'nonce'; type: 'uint48' },
    ]
    PermitSingle: [
      { name: 'details'; type: 'PermitDetails' },
      { name: 'spender'; type: 'address' },
      { name: 'sigDeadline'; type: 'uint256' },
    ]
  }
  primaryType: 'PermitSingle'
  message: {
    details: {
      token: `0x${string}`
      amount: string // uint160 stringified
      expiration: number
      nonce: number
    }
    spender: `0x${string}`
    sigDeadline: string // uint256 stringified
  }
}

export interface BuildPermitTypedDataInput {
  token: `0x${string}`
  amount: bigint
  expiration: number
  nonce: number
  sigDeadline: bigint
  spender?: `0x${string}` // defaults to UniversalRouter
  chainId?: number // defaults to Celo mainnet
}

export function buildPermit2TypedData(
  input: BuildPermitTypedDataInput,
): Permit2TypedData {
  const spender = input.spender ?? UNIVERSAL_ROUTER_ADDRESS
  const chainId = input.chainId ?? CELO_CHAIN_ID
  return {
    domain: {
      name: 'Permit2',
      chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: {
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    },
    primaryType: 'PermitSingle',
    message: {
      details: {
        token: input.token,
        amount: input.amount.toString(),
        expiration: input.expiration,
        nonce: input.nonce,
      },
      spender,
      sigDeadline: input.sigDeadline.toString(),
    },
  }
}

// -----------------------------------------------------------------------
// UniversalRouter.execute() calldata builder
// -----------------------------------------------------------------------

export interface BuildV4SwapCalldataInput {
  direction: UniswapV4Direction
  // Recipient of the output tokens (the user's wallet address).
  recipient: `0x${string}`
  // Exact amount of input token to sell (uint128 range).
  sellAmount: bigint
  // Minimum acceptable amount of output token AFTER the fee is deducted.
  // The pool-side slippage bound is set slightly higher to account for the
  // TAKE_PORTION fee, see body for the arithmetic.
  minBuyAmount: bigint
  // Unix seconds after which the UniversalRouter.execute() call reverts.
  deadline: bigint
  // Fully-signed PermitSingle. Backend takes what the wallet returned from
  // eth_signTypedData_v4 (65-byte r||s||v).
  permit2Signature: `0x${string}`
  // The exact PermitSingle values the wallet signed. Backend re-uses these
  // verbatim; any mismatch and Permit2 will revert.
  permitDetails: {
    token: `0x${string}`
    amount: bigint
    expiration: number
    nonce: number
  }
  permitSpender?: `0x${string}` // defaults to UniversalRouter
  permitSigDeadline: bigint
}

export interface BuiltSwapTx {
  to: `0x${string}`
  data: `0x${string}`
  value: bigint
}

// Packs a list of 1-byte commands into a single hex string ("bytes commands")
// consumed by UniversalRouter.execute.
function packCommands(bytes: readonly number[]): `0x${string}` {
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `0x${hex}` as `0x${string}`
}

// Packs a list of 1-byte actions into "bytes actions" consumed by
// V4Router._executeActionsWithoutUnlock.
function packActions(bytes: readonly number[]): `0x${string}` {
  return packCommands(bytes)
}

// SWAP_EXACT_IN_SINGLE params: (PoolKey, bool zeroForOne, uint128 amountIn,
// uint128 amountOutMinimum, bytes hookData). The pool-side amountOutMinimum
// is the gross output floor (before the fee TAKE_PORTION is deducted).
const SWAP_EXACT_IN_SINGLE_PARAMS_TYPE = {
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
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
} as const

// PermitDetails / PermitSingle ABI types (for the PERMIT2_PERMIT input).
const PERMIT_SINGLE_TYPE = {
  type: 'tuple',
  components: [
    {
      name: 'details',
      type: 'tuple',
      components: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
} as const

// UniversalRouter.execute(bytes commands, bytes[] inputs, uint256 deadline)
const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

// Internal: builds the V4_SWAP command input (SWAP_EXACT_IN_SINGLE +
// SETTLE_ALL + TAKE_PORTION? + TAKE_ALL). Shared between the Permit2-sig
// path and the batchCalls path. Returns the encoded bytes suitable as
// UniversalRouter.execute()'s `inputs[]` entry for the V4_SWAP command.
function buildV4SwapInput(
  direction: UniswapV4Direction,
  sellAmount: bigint,
  minBuyAmount: bigint,
): `0x${string}` {
  const zeroForOne = direction === 'USDT_TO_COPM'
  const inputCurrency = zeroForOne
    ? POOL_USDT_COPM.currency0
    : POOL_USDT_COPM.currency1
  const outputCurrency = zeroForOne
    ? POOL_USDT_COPM.currency1
    : POOL_USDT_COPM.currency0
  const feeBips = getIntegratorFeeBips()
  const feeRecipient = getFeeRecipient()
  const collectFee = feeRecipient !== null

  const poolMinOut = collectFee
    ? (minBuyAmount * 10000n + (10000n - BigInt(feeBips) - 1n)) /
      (10000n - BigInt(feeBips))
    : minBuyAmount

  const MAX_U128 = (1n << 128n) - 1n
  if (sellAmount > MAX_U128) throw new Error('sellAmount exceeds uint128')
  if (poolMinOut > MAX_U128) throw new Error('poolMinOut exceeds uint128')

  const swapActions = collectFee
    ? [
        ACT_SWAP_EXACT_IN_SINGLE,
        ACT_SETTLE_ALL,
        ACT_TAKE_PORTION,
        ACT_TAKE_ALL,
      ]
    : [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]

  const swapExactInSingleParams = encodeAbiParameters(
    [SWAP_EXACT_IN_SINGLE_PARAMS_TYPE],
    [
      {
        poolKey: {
          currency0: POOL_USDT_COPM.currency0,
          currency1: POOL_USDT_COPM.currency1,
          fee: POOL_USDT_COPM.fee,
          tickSpacing: POOL_USDT_COPM.tickSpacing,
          hooks: POOL_USDT_COPM.hooks,
        },
        zeroForOne,
        amountIn: sellAmount,
        amountOutMinimum: poolMinOut,
        hookData: '0x' as `0x${string}`,
      } as unknown as never,
    ],
  )
  const settleAllParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [inputCurrency, sellAmount],
  )
  const takeAllParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [outputCurrency, minBuyAmount],
  )
  const swapParams: `0x${string}`[] = collectFee
    ? [
        swapExactInSingleParams,
        settleAllParams,
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
          [outputCurrency, feeRecipient!, BigInt(feeBips)],
        ),
        takeAllParams,
      ]
    : [swapExactInSingleParams, settleAllParams, takeAllParams]

  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [packActions(swapActions), swapParams],
  )
}

export function buildV4SwapCalldata(
  input: BuildV4SwapCalldataInput,
): BuiltSwapTx {
  if (input.permit2Signature.length !== 132) {
    // 0x + 65 bytes * 2 hex chars = 132
    throw new Error(
      `permit2Signature must be 65 bytes (0x + 130 hex), got ${input.permit2Signature.length} chars`,
    )
  }
  if (hexToBytes(input.permit2Signature).length !== 65) {
    throw new Error('permit2Signature is not 65 raw bytes')
  }

  const v4SwapInput = buildV4SwapInput(
    input.direction,
    input.sellAmount,
    input.minBuyAmount,
  )

  // -----------------------------------------------------------------------
  // Build PERMIT2_PERMIT input: abi.encode(PermitSingle, bytes signature)
  // -----------------------------------------------------------------------

  const permitSpender = input.permitSpender ?? UNIVERSAL_ROUTER_ADDRESS
  const permitInput = encodeAbiParameters(
    [PERMIT_SINGLE_TYPE, { type: 'bytes' }],
    [
      {
        details: {
          token: input.permitDetails.token,
          amount: input.permitDetails.amount,
          expiration: input.permitDetails.expiration,
          nonce: input.permitDetails.nonce,
        },
        spender: permitSpender,
        sigDeadline: input.permitSigDeadline,
      } as unknown as never,
      input.permit2Signature,
    ],
  )

  const commands = packCommands([CMD_PERMIT2_PERMIT, CMD_V4_SWAP])
  const data = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [commands, [permitInput, v4SwapInput], input.deadline],
  })

  return { to: UNIVERSAL_ROUTER_ADDRESS, data, value: 0n }
}

// -----------------------------------------------------------------------
// EIP-7702 delegated flow: build the two calldatas the wallet's
// BatchExecutor will execute atomically (no Permit2 signature required)
// -----------------------------------------------------------------------

export interface BuildBatchedCallsInput {
  direction: UniswapV4Direction
  sellAmount: bigint
  minBuyAmount: bigint
  // Unix seconds; UniversalRouter.execute reverts after this.
  deadline: bigint
  // Permit2.approve expiration. Should be far enough that subsequent swaps
  // in the same batch cycle can reuse the allowance if the wallet chooses.
  approveExpiration: number
}

// Builds calldata for `Permit2.approve(token, spender, amount, expiration)`.
// Used inside the BatchExecutor batch for EIP-7702 delegated wallets that
// cannot sign Permit2 typed data (BatchExecutor does not implement ERC1271).
// msg.sender inside the delegated context is the wallet EOA, so Permit2
// updates `allowance[wallet][token][UniversalRouter]` directly with no
// signature needed.
export function buildPermit2ApproveCalldata(
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
  expiration: number,
): `0x${string}` {
  const MAX_U160 = (1n << 160n) - 1n
  if (amount > MAX_U160) throw new Error('amount exceeds uint160')
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'approve',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'token', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
        ],
        outputs: [],
      },
    ] as const,
    functionName: 'approve',
    args: [token, spender, amount, expiration],
  })
}

// Builds the UniversalRouter.execute() calldata for a V4 swap WITHOUT the
// PERMIT2_PERMIT command. Callers (typically the /api/swap/quote handler
// on the EIP-7702 delegated path) are responsible for ensuring Permit2 has
// the required allowance to UniversalRouter beforehand (via a preceding
// Permit2.approve call inside the same BatchExecutor batch).
export function buildV4SwapCalldataNoPermit(
  input: BuildBatchedCallsInput,
): BuiltSwapTx {
  const v4SwapInput = buildV4SwapInput(
    input.direction,
    input.sellAmount,
    input.minBuyAmount,
  )
  const commands = packCommands([CMD_V4_SWAP])
  const data = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [commands, [v4SwapInput], input.deadline],
  })
  return { to: UNIVERSAL_ROUTER_ADDRESS, data, value: 0n }
}

// High-level helper: builds both calldatas the wallet's BatchExecutor
// executes atomically for an EIP-7702 delegated user. First call ensures
// Permit2 has the allowance; second call performs the swap. Returns the
// pair in the exact order the batch must execute.
export interface BatchedSwapCalls {
  approve: BuiltSwapTx
  swap: BuiltSwapTx
}

export function buildEip7702BatchedSwapCalls(
  input: BuildBatchedCallsInput & { sellToken: `0x${string}` },
): BatchedSwapCalls {
  const approveData = buildPermit2ApproveCalldata(
    input.sellToken,
    UNIVERSAL_ROUTER_ADDRESS,
    input.sellAmount,
    input.approveExpiration,
  )
  const swap = buildV4SwapCalldataNoPermit(input)
  const approve: BuiltSwapTx = {
    to: PERMIT2_ADDRESS,
    data: approveData,
    value: 0n,
  }
  log.info(
    `built EIP-7702 batched calls direction=${input.direction} sell=${input.sellAmount.toString()} min=${input.minBuyAmount.toString()} deadline=${input.deadline.toString()}`,
  )
  return { approve, swap }
}

// -----------------------------------------------------------------------
// EIP-7702 delegation detection
// -----------------------------------------------------------------------

// Returns true when the given address has EIP-7702 delegation code
// (0xef01 prefix, 23 bytes total: 3-byte magic + 20-byte delegate address).
// Non-delegated EOAs return false (code.length == 0). Regular contracts
// also return false (their code doesn't start with the 0xef01 magic).
export async function isEip7702Delegated(
  address: `0x${string}`,
): Promise<boolean> {
  const executor = getSharedCeloFallbackExecutor()
  try {
    const code = await executor.withFallback(
      'eip7702:getCode',
      async (client: PublicClient) => client.getCode({ address }),
    )
    if (!code || code === '0x') return false
    // EIP-7702 delegation payload is exactly 23 bytes: `0xef01` + 1-byte
    // version + 20-byte delegate address. In practice observed on Celo as
    // `0xef0100 + 40-hex delegate`.
    return code.length === 48 && code.toLowerCase().startsWith('0xef0100')
  } catch (err) {
    log.warn(
      `isEip7702Delegated failed for ${address}, assuming NOT delegated: ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

