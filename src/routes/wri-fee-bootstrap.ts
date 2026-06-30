import { Router, Request, Response } from 'express'
import { encodeFunctionData, type Hex } from 'viem'
import { env } from '../lib/env'
import { HEX_ADDRESS_RE } from '../lib/hex'
import { createLogger } from '../lib/logger'
import {
  BATCH_EXECUTOR_ADDRESS,
  BATCH_EXECUTOR_ADDRESS_LOWER,
  EIP_7702_DELEGATED_CODE_PREFIX,
} from '../lib/networks'
import { getRelayClients } from '../lib/wriRelay'

// POST /api/wri/fee-adapter-bootstrap
//
// Sponsors a single approve(adapter, MAX_UINT256) on each adapter-only
// token (USDC, USDT, ...) the user holds. Without this, users whose only
// dollar-denominated balance is in adapter-only stables cannot pay gas on
// any tx, ever (chicken-and-egg: adapter needs allowance, allowance needs
// gas, gas needs allowance).
//
// Precondition: user's EOA must already be delegated to BatchExecutor (via
// the EIP-7702 flow served at POST /api/wri/delegate-relay). The relay
// sends a tx to the user EOA calling
//   BatchExecutor.execute([(token, 0, approve(adapter, MAX_UINT256))])
// so msg.sender of the approve() is the user EOA, not the relay. The relay
// only pays gas.
//
// MVP scope: USDC + USDT. Adapter addresses come from env so the operator
// can rotate them without a code change. Allowance >= 2**200 is treated as
// already-bootstrapped (effectively unlimited; reserves the top 56 bits as
// a "manually revoked" sentinel range).

const router = Router()
const log = createLogger('routes:wri-fee-bootstrap')

const MAX_UINT256 = (1n << 256n) - 1n
const MIN_BOOTSTRAP_ALLOWANCE = 1n << 200n

const RECEIPT_TIMEOUT_MS = 30_000

// Token contracts known to be adapter-only on Celo mainnet today. The set is
// hardcoded so we never approve a random adapter address; env only supplies
// the adapter contract, not the token.
const ADAPTER_TOKENS = [
  {
    symbol: 'USDC',
    tokenAddress: '0xceba9300f2b948710d2653dd7b07f33a8b32118c' as Hex,
    adapterEnvVar: 'WRI_FEE_ADAPTER_USDC' as const,
  },
  {
    symbol: 'USDT',
    tokenAddress: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Hex,
    adapterEnvVar: 'WRI_FEE_ADAPTER_USDT' as const,
  },
] as const

// Minimal ERC20 + BatchExecutor ABIs. Inlined so the route module is
// self-contained; no risk of a typo in an unused field affecting decode.
const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const BATCH_EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const

interface TokenResult {
  tokenSymbol: string
  tokenAddress: string
  adapterAddress: string
  status:
    | 'approved'
    | 'already_approved'
    | 'skipped_no_balance'
    | 'skipped_no_adapter'
    | 'relay_failed'
  txHash: string | null
  alreadyApproved: boolean
}

function isDelegatedToBatchExecutor(code: Hex | undefined): boolean {
  if (!code) return false
  const lower = code.toLowerCase()
  const expected = `${EIP_7702_DELEGATED_CODE_PREFIX}${BATCH_EXECUTOR_ADDRESS_LOWER.slice(2)}`
  return lower === expected
}

interface BootstrapRpc {
  readContract: (args: {
    address: Hex
    abi: typeof ERC20_ABI
    functionName: 'balanceOf' | 'allowance'
    args: readonly Hex[]
  }) => Promise<bigint>
  getCode: (args: { address: Hex }) => Promise<Hex | undefined>
  sendTransaction: (args: {
    to: Hex
    data: Hex
    feeCurrency?: Hex
  }) => Promise<Hex>
  waitForTransactionReceipt: (args: {
    hash: Hex
    timeout?: number
  }) => Promise<{ status: 'success' | 'reverted' }>
}

// Surface used in tests to inject a fake relay clients module. Production
// always uses the real getRelayClients(); see wriRelay.ts.
export interface BootstrapDeps {
  rpc?: BootstrapRpc
  relayAddress?: Hex
}

async function processToken(
  rpc: BootstrapRpc,
  userAddress: Hex,
  token: (typeof ADAPTER_TOKENS)[number],
): Promise<TokenResult> {
  const adapter = env[token.adapterEnvVar]
  if (!adapter) {
    return {
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      adapterAddress: '',
      status: 'skipped_no_adapter',
      txHash: null,
      alreadyApproved: false,
    }
  }
  const adapterHex = adapter as Hex

  let balance: bigint
  try {
    balance = await rpc.readContract({
      address: token.tokenAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [userAddress],
    })
  } catch (err) {
    log.warn(
      `balanceOf failed for ${token.symbol}: ${err instanceof Error ? err.message : err}`,
    )
    return {
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      adapterAddress: adapter,
      status: 'relay_failed',
      txHash: null,
      alreadyApproved: false,
    }
  }
  if (balance === 0n) {
    return {
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      adapterAddress: adapter,
      status: 'skipped_no_balance',
      txHash: null,
      alreadyApproved: false,
    }
  }

  let allowance: bigint
  try {
    allowance = await rpc.readContract({
      address: token.tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [userAddress, adapterHex],
    })
  } catch (err) {
    log.warn(
      `allowance read failed for ${token.symbol}: ${err instanceof Error ? err.message : err}`,
    )
    return {
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      adapterAddress: adapter,
      status: 'relay_failed',
      txHash: null,
      alreadyApproved: false,
    }
  }
  if (allowance >= MIN_BOOTSTRAP_ALLOWANCE) {
    return {
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      adapterAddress: adapter,
      status: 'already_approved',
      txHash: null,
      alreadyApproved: true,
    }
  }

  // Build the inner approve(adapter, MAX_UINT256) calldata.
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [adapterHex, MAX_UINT256],
  })

  // Wrap in BatchExecutor.execute([(token, 0, approveData)]). The outer tx
  // targets the user EOA which is delegated to BatchExecutor; this is what
  // makes msg.sender = userEOA inside the approve.
  const outerData = encodeFunctionData({
    abi: BATCH_EXECUTOR_ABI,
    functionName: 'execute',
    args: [[{ target: token.tokenAddress, value: 0n, data: approveData }]],
  })

  let txHash: Hex
  try {
    txHash = await rpc.sendTransaction({
      to: userAddress,
      data: outerData,
    })
  } catch (err) {
    log.error(
      `sendTransaction failed for ${token.symbol}: ${err instanceof Error ? err.message : err}`,
    )
    return {
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      adapterAddress: adapter,
      status: 'relay_failed',
      txHash: null,
      alreadyApproved: false,
    }
  }

  try {
    const receipt = await rpc.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    })
    if (receipt.status !== 'success') {
      log.error(`approve tx reverted: hash=${txHash} token=${token.symbol}`)
      return {
        tokenSymbol: token.symbol,
        tokenAddress: token.tokenAddress,
        adapterAddress: adapter,
        status: 'relay_failed',
        txHash,
        alreadyApproved: false,
      }
    }
  } catch (err) {
    log.error(
      `waitForTransactionReceipt failed for ${token.symbol}: ${err instanceof Error ? err.message : err}`,
    )
    return {
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      adapterAddress: adapter,
      status: 'relay_failed',
      txHash,
      alreadyApproved: false,
    }
  }

  return {
    tokenSymbol: token.symbol,
    tokenAddress: token.tokenAddress,
    adapterAddress: adapter,
    status: 'approved',
    txHash,
    alreadyApproved: false,
  }
}

// Exported for tests; the route handler below wraps this with input validation
// + relay clients lookup + the kill switch.
export async function bootstrapFeeAdapters(
  userAddress: Hex,
  rpc: BootstrapRpc,
): Promise<{ ok: boolean; results: TokenResult[] }> {
  const userCode = (await rpc.getCode({ address: userAddress })) ?? ('0x' as Hex)
  if (!isDelegatedToBatchExecutor(userCode)) {
    return {
      ok: false,
      results: [],
    }
  }

  const results: TokenResult[] = []
  for (const token of ADAPTER_TOKENS) {
    results.push(await processToken(rpc, userAddress, token))
  }
  return { ok: true, results }
}

router.post('/api/wri/fee-adapter-bootstrap', async (req: Request, res: Response) => {
  if (!env.WRI_FEE_BOOTSTRAP_ENABLED) {
    return res.status(503).json({ error: 'fee bootstrap disabled' })
  }

  const body = (req.body ?? {}) as { address?: unknown }
  if (typeof body.address !== 'string' || !HEX_ADDRESS_RE.test(body.address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const userAddress = body.address as Hex

  const relay = getRelayClients()
  if (!relay) {
    return res.status(503).json({ error: 'relay temporarily unavailable' })
  }

  // Adapter wrapper: forwards to viem's relay clients with the expected
  // shape. Keeps BootstrapRpc decoupled from viem types for testability.
  // The viem readContract overload narrows `args` per `functionName`; our
  // BootstrapRpc keeps it as a plain Hex[] for testability, so we widen the
  // call here via a typed-any forward.
  const rpc: BootstrapRpc = {
    readContract: (args) =>
      (relay.publicClient.readContract as unknown as (a: unknown) => Promise<bigint>)({
        address: args.address,
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      }),
    getCode: (args) => relay.publicClient.getCode({ address: args.address }),
    sendTransaction: (args) =>
      relay.walletClient.sendTransaction({
        account: relay.account,
        chain: relay.walletClient.chain,
        to: args.to,
        data: args.data,
        value: 0n,
      }),
    waitForTransactionReceipt: (args) =>
      relay.publicClient.waitForTransactionReceipt({
        hash: args.hash,
        timeout: args.timeout,
      }),
  }

  let result: { ok: boolean; results: TokenResult[] }
  try {
    result = await bootstrapFeeAdapters(userAddress, rpc)
  } catch (err) {
    log.error(
      `bootstrapFeeAdapters threw: ${err instanceof Error ? err.message : err}`,
    )
    return res.status(500).json({ error: 'internal' })
  }

  if (!result.ok) {
    return res
      .status(412)
      .json({ error: 'precondition failed: user not delegated to BatchExecutor' })
  }
  // Empty results means no adapter env vars are configured. Surface a
  // distinct 503 so the operator notices instead of returning an empty 200.
  if (result.results.length === 0) {
    return res
      .status(503)
      .json({ error: 'no adapter tokens configured (set WRI_FEE_ADAPTER_*)' })
  }

  return res.json({ ok: true, results: result.results, relayAddress: relay.account.address })
})

// Exported for tests that need to confirm the route handler is the one
// wired into app.ts (matches the pattern in routes/wri.ts).
export { BATCH_EXECUTOR_ADDRESS, MIN_BOOTSTRAP_ALLOWANCE, MAX_UINT256 }

export default router
