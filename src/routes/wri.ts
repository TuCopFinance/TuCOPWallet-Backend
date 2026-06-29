import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import type { Hex } from 'viem'
import { recoverAuthorizationAddress } from 'viem/utils'
import { parseEnvBigInt } from '../lib/env'
import { HEX_ADDRESS_RE, HEX_BYTES32_RE } from '../lib/hex'
import { createLogger } from '../lib/logger'
import {
  BATCH_EXECUTOR_ADDRESS,
  BATCH_EXECUTOR_ADDRESS_LOWER,
  CELO_MAINNET_CHAIN_ID,
  EIP_7702_DELEGATED_CODE_PREFIX,
} from '../lib/networks'
import { getRedis } from '../lib/redis'
import { getRelayClients } from '../lib/wriRelay'
import {
  tryAcquireDelegateRelaySlot,
  tryAcquireGlobalRelaySlot,
  WRI_GLOBAL_LIMIT_DEFAULT,
  WRI_GLOBAL_LIMIT_WINDOW_SECONDS,
  WRI_RATE_LIMIT_WINDOW_SECONDS,
} from '../lib/wriRateLimit'

const router = Router()
const log = createLogger('routes:wri')

// Re-exports kept for the small number of tests that import these from the
// route module rather than from `lib/networks`.
export const CELO_CHAIN_ID = CELO_MAINNET_CHAIN_ID
export { BATCH_EXECUTOR_ADDRESS }

const DEFAULT_MIN_BALANCE_WEI = 500000000000000000n
const DEFAULT_MAX_GAS = 1000000n
const RECEIPT_TIMEOUT_MS = 30_000
const POST_MINING_MAX_ATTEMPTS = 4
const POST_MINING_RETRY_DELAY_MS = 500

// Per-IP tier: 20 relays per IP per minute. The global 300 req/min/IP ceiling
// in app.ts is shared across every endpoint; this tighter route-specific
// limit blocks address-spraying from a single source. Tunable via env so the
// number can be calibrated against real prod traffic. Setting the env var to
// 0 disables the limiter (used in tests via jest.setup.ts).
const DEFAULT_PER_IP_LIMIT = 20n
const PER_IP_WINDOW_MS = 60_000

function getPerIpLimit(): number {
  return Number(parseEnvBigInt('WRI_RELAY_PER_IP_LIMIT', DEFAULT_PER_IP_LIMIT))
}

const perIpLimiter = rateLimit({
  windowMs: PER_IP_WINDOW_MS,
  limit: getPerIpLimit,
  // Skip when the configured limit is 0. Returning true bypasses the limiter
  // for this request without consuming a slot.
  skip: () => getPerIpLimit() === 0,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'ip rate limited' },
})

const Y_PARITY_RE = /^0x[01]$/

interface IncomingSignedAuthorization {
  chainId: unknown
  address: unknown
  nonce: unknown
  yParity: unknown
  r: unknown
  s: unknown
}

interface RequestBody {
  userAddress?: unknown
  signedAuthorization?: unknown
}

interface ParsedAuth {
  chainId: number
  address: Hex
  nonce: number
  yParity: number
  r: Hex
  s: Hex
}

// Hex string of any length, used only to parse small numeric fields (chainId,
// nonce) where r/s would be rejected by the bytes32 check below.
const SHORT_HEX_RE = /^0x[a-fA-F0-9]*$/

function parseHexBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  if (!SHORT_HEX_RE.test(value)) return null
  if (value === '0x') return 0n
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function parseAuthorization(raw: unknown): ParsedAuth | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as IncomingSignedAuthorization

  const chainIdBn = parseHexBigInt(obj.chainId)
  if (chainIdBn === null) return null
  if (chainIdBn > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const chainId = Number(chainIdBn)

  if (typeof obj.address !== 'string' || !HEX_ADDRESS_RE.test(obj.address)) return null
  const address = obj.address as Hex

  const nonceBn = parseHexBigInt(obj.nonce)
  if (nonceBn === null) return null
  if (nonceBn < 0n || nonceBn > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const nonce = Number(nonceBn)

  if (typeof obj.yParity !== 'string' || !Y_PARITY_RE.test(obj.yParity)) return null
  const yParity = obj.yParity === '0x1' ? 1 : 0

  // r/s MUST be exactly 32 bytes. Variable-length hex would let `0x` or other
  // truncated values reach viem's signature recovery with undefined behavior.
  if (typeof obj.r !== 'string' || !HEX_BYTES32_RE.test(obj.r)) return null
  if (typeof obj.s !== 'string' || !HEX_BYTES32_RE.test(obj.s)) return null

  return {
    chainId,
    address,
    nonce,
    yParity,
    r: obj.r as Hex,
    s: obj.s as Hex,
  }
}

function isDelegatedToBatchExecutor(code: Hex | undefined): boolean {
  if (!code) return false
  const lower = code.toLowerCase()
  const expected = `${EIP_7702_DELEGATED_CODE_PREFIX}${BATCH_EXECUTOR_ADDRESS_LOWER.slice(2)}`
  return lower === expected
}

router.post('/api/wri/delegate-relay', perIpLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as RequestBody

  if (typeof body.userAddress !== 'string' || !HEX_ADDRESS_RE.test(body.userAddress)) {
    return res.status(400).json({ error: 'invalid userAddress' })
  }
  const userAddress = body.userAddress as Hex
  const userAddressLower = userAddress.toLowerCase()

  const auth = parseAuthorization(body.signedAuthorization)
  if (!auth) {
    return res.status(400).json({ error: 'invalid signedAuthorization' })
  }

  if (auth.chainId !== CELO_MAINNET_CHAIN_ID) {
    return res.status(400).json({ error: 'invalid chainId' })
  }

  if (auth.address.toLowerCase() !== BATCH_EXECUTOR_ADDRESS_LOWER) {
    log.warn(
      `delegation target mismatch: got=${auth.address} expected=${BATCH_EXECUTOR_ADDRESS}`,
    )
    return res.status(400).json({ error: 'invalid delegation target' })
  }

  const relay = getRelayClients()
  if (!relay) {
    log.error('relay hot wallet not configured (WRI_RELAY_PK missing or invalid)')
    return res.status(503).json({ error: 'relay temporarily unavailable' })
  }

  // Global token bucket: caps total relay submissions across ALL addresses + IPs
  // per minute. Defense in depth against address-spraying that bypasses the
  // per-IP tier (e.g. attacker distributed across many source IPs).
  // Fail-closed when Redis is unavailable - the bucket needs shared state.
  // Setting WRI_RELAY_GLOBAL_LIMIT=0 disables the tier (used in tests).
  const redis = getRedis()
  const globalLimit = Number(parseEnvBigInt('WRI_RELAY_GLOBAL_LIMIT', BigInt(WRI_GLOBAL_LIMIT_DEFAULT)))
  if (globalLimit > 0) {
    let globalSlot: { acquired: boolean; ttlSeconds?: number; count?: number }
    try {
      globalSlot = await tryAcquireGlobalRelaySlot(redis, globalLimit)
    } catch (err) {
      log.error('global rate-limit error:', err instanceof Error ? err.message : err)
      return res.status(503).json({ error: 'rate limiter unavailable' })
    }
    if (!globalSlot.acquired) {
      res.setHeader(
        'Retry-After',
        String(globalSlot.ttlSeconds ?? WRI_GLOBAL_LIMIT_WINDOW_SECONDS),
      )
      log.warn(
        `global relay bucket exhausted: count=${globalSlot.count ?? 'unknown'} limit=${globalLimit}`,
      )
      return res.status(429).json({ error: 'relay globally rate limited' })
    }
  }

  let recovered: string
  try {
    recovered = await recoverAuthorizationAddress({
      authorization: {
        address: auth.address,
        chainId: auth.chainId,
        nonce: auth.nonce,
        yParity: auth.yParity,
        r: auth.r,
        s: auth.s,
      },
    })
  } catch (err) {
    log.warn(
      'signature recovery failed:',
      err instanceof Error ? err.message : err,
    )
    return res.status(400).json({ error: 'invalid signature' })
  }
  if (recovered.toLowerCase() !== userAddressLower) {
    log.warn(
      `recovered signer mismatch: recovered=${recovered} userAddress=${userAddress}`,
    )
    return res.status(400).json({ error: 'invalid signature' })
  }

  let onChainNonce: bigint
  try {
    onChainNonce = BigInt(
      await relay.publicClient.getTransactionCount({ address: userAddress, blockTag: 'latest' }),
    )
  } catch (err) {
    log.warn('getTransactionCount failed:', err instanceof Error ? err.message : err)
    return res.status(502).json({ error: 'rpc unavailable' })
  }
  // Nonce MUST equal the on-chain nonce exactly. The previous window of
  // [-1, +1] admitted two ambiguous cases without payoff:
  //   - delta = -1: stale auth (lower than chain) - tx submission would
  //     always fail with "nonce too low"; we may as well reject up front.
  //   - delta = +1: future-nonce auth - the wallet would need to submit a
  //     prior tx before this one anyway; relaying it would either revert
  //     (nonce gap) or burn relay gas on a redundant delegation after the
  //     prior one already delegated the EOA. The already_delegated short-
  //     circuit + the post-mining getCode poll downstream already cover
  //     the propagation-lag case that motivated the original window.
  const submittedNonce = BigInt(auth.nonce)
  if (submittedNonce !== onChainNonce) {
    return res.status(400).json({ error: 'nonce mismatch' })
  }

  let userCode: Hex
  try {
    const fetched = await relay.publicClient.getCode({ address: userAddress })
    userCode = (fetched ?? '0x') as Hex
  } catch (err) {
    log.warn('getCode failed:', err instanceof Error ? err.message : err)
    return res.status(502).json({ error: 'rpc unavailable' })
  }
  if (isDelegatedToBatchExecutor(userCode)) {
    return res.json({
      status: 'already_delegated',
      userAddress,
      delegatedTo: BATCH_EXECUTOR_ADDRESS,
    })
  }

  let relayBalance: bigint
  try {
    relayBalance = await relay.publicClient.getBalance({ address: relay.account.address })
  } catch (err) {
    log.warn('getBalance failed:', err instanceof Error ? err.message : err)
    return res.status(502).json({ error: 'rpc unavailable' })
  }
  const minBalance = parseEnvBigInt('WRI_RELAY_MIN_CELO_BALANCE', DEFAULT_MIN_BALANCE_WEI)
  if (relayBalance < minBalance) {
    log.warn(
      `relay balance below threshold: balance=${relayBalance.toString()} minBalance=${minBalance.toString()} relay=${relay.account.address}`,
    )
    return res.status(503).json({ error: 'relay temporarily unavailable' })
  }

  // Fail-closed: a Redis outage previously fell back to `acquired: true` so an
  // attacker could drain the relay hot wallet during downtime. The library now
  // falls back to a bounded in-memory store when Redis is absent (passing `null`),
  // and any unexpected Redis error returns 503 instead of bypassing the limit.
  let slot: { acquired: boolean; ttlSeconds?: number }
  try {
    slot = await tryAcquireDelegateRelaySlot(redis, userAddressLower)
  } catch (err) {
    log.error('rate-limit store error:', err instanceof Error ? err.message : err)
    return res.status(503).json({ error: 'rate limiter unavailable' })
  }
  if (!slot.acquired) {
    res.setHeader('Retry-After', String(slot.ttlSeconds ?? WRI_RATE_LIMIT_WINDOW_SECONDS))
    return res.status(429).json({ error: 'address rate limited' })
  }

  const maxGas = parseEnvBigInt('WRI_RELAY_MAX_GAS', DEFAULT_MAX_GAS)

  let txHash: Hex
  try {
    txHash = await relay.walletClient.sendTransaction({
      account: relay.account,
      chain: relay.walletClient.chain,
      to: relay.account.address,
      value: 0n,
      gas: maxGas,
      authorizationList: [
        {
          address: auth.address,
          chainId: auth.chainId,
          nonce: auth.nonce,
          yParity: auth.yParity,
          r: auth.r,
          s: auth.s,
        },
      ],
    })
  } catch (err) {
    log.error('sendTransaction failed:', err instanceof Error ? err.message : err)
    return res.status(502).json({ error: 'relay tx submission failed' })
  }

  try {
    const receipt = await relay.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    })
    if (receipt.status !== 'success') {
      // Log only the receipt fields useful for diagnosis. JSON.stringify on the
      // full receipt also serialises receipt.logs which may include event data
      // from attacker-influenced contracts; trimming caps log volume and avoids
      // log-injection / log-shipping leakage on a hot relay-revert path.
      log.error(
        `relay tx reverted: hash=${txHash} status=${receipt.status} blockNumber=${receipt.blockNumber?.toString() ?? 'unknown'} gasUsed=${receipt.gasUsed?.toString() ?? 'unknown'}`,
      )
      return res.status(502).json({ error: 'relay tx reverted' })
    }
  } catch (err) {
    log.error('waitForTransactionReceipt failed:', err instanceof Error ? err.message : err)
    return res.status(502).json({ error: 'relay tx unconfirmed' })
  }

  // Forno occasionally lags state propagation behind receipt availability; the
  // receipt is already SUCCESS at this point, so a short retry loop absorbs
  // the gap without changing semantics.
  let postCode: Hex = '0x' as Hex
  for (let attempt = 0; attempt < POST_MINING_MAX_ATTEMPTS; attempt++) {
    try {
      const fetched = await relay.publicClient.getCode({ address: userAddress })
      postCode = (fetched ?? '0x') as Hex
    } catch (err) {
      log.warn('post-mining getCode failed:', err instanceof Error ? err.message : err)
      return res.status(502).json({ error: 'relay tx unverified' })
    }
    if (isDelegatedToBatchExecutor(postCode)) break
    if (attempt < POST_MINING_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, POST_MINING_RETRY_DELAY_MS))
    }
  }
  if (!isDelegatedToBatchExecutor(postCode)) {
    log.error(
      `post-mining delegation not detected after ${POST_MINING_MAX_ATTEMPTS} attempts: hash=${txHash} userAddress=${userAddress} code=${postCode}`,
    )
    return res.status(502).json({ error: 'relay tx unverified' })
  }

  return res.json({
    status: 'delegated',
    txHash,
    userAddress,
    delegatedTo: BATCH_EXECUTOR_ADDRESS,
  })
})

export default router
