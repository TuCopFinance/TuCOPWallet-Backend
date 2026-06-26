import { Router, Request, Response } from 'express'
import type { Hex } from 'viem'
import { recoverAuthorizationAddress } from 'viem/utils'
import { HEX_ADDRESS_RE } from '../lib/hex'
import { createLogger } from '../lib/logger'
import { getRedis } from '../lib/redis'
import { getRelayClients } from '../lib/wriRelay'
import { tryAcquireDelegateRelaySlot, WRI_RATE_LIMIT_WINDOW_SECONDS } from '../lib/wriRateLimit'

const router = Router()
const log = createLogger('routes:wri')

export const CELO_CHAIN_ID = 42220
export const BATCH_EXECUTOR_ADDRESS = '0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe'
const BATCH_EXECUTOR_ADDRESS_LOWER = BATCH_EXECUTOR_ADDRESS.toLowerCase()

const DEFAULT_MIN_BALANCE_WEI = 500000000000000000n
const DEFAULT_MAX_GAS = 1000000n
const RECEIPT_TIMEOUT_MS = 30_000
const POST_MINING_MAX_ATTEMPTS = 4
const POST_MINING_RETRY_DELAY_MS = 500

// Variable-length hex string (signature components r/s); not a single fixed
// width like the address/topic helpers in lib/hex.ts.
const HEX_RE = /^0x[a-fA-F0-9]*$/
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

function parseHexBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  if (!HEX_RE.test(value)) return null
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

  if (typeof obj.r !== 'string' || !HEX_RE.test(obj.r)) return null
  if (typeof obj.s !== 'string' || !HEX_RE.test(obj.s)) return null

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
  const expected = `0xef0100${BATCH_EXECUTOR_ADDRESS_LOWER.slice(2)}`
  return lower === expected
}

router.post('/api/wri/delegate-relay', async (req: Request, res: Response) => {
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

  if (auth.chainId !== CELO_CHAIN_ID) {
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
  const submittedNonce = BigInt(auth.nonce)
  const nonceDelta = submittedNonce - onChainNonce
  if (nonceDelta < -1n || nonceDelta > 1n) {
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

  const redis = getRedis()
  const slot = await tryAcquireDelegateRelaySlot(redis, userAddressLower).catch((err) => {
    log.warn('rate-limit store error:', err instanceof Error ? err.message : err)
    return { acquired: true as const }
  })
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
      log.error(`relay tx reverted: hash=${txHash} receipt=${JSON.stringify(receipt)}`)
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

function parseEnvBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (!raw) return fallback
  try {
    const v = BigInt(raw)
    return v >= 0n ? v : fallback
  } catch {
    return fallback
  }
}

export default router
