// Builds a provisional (pre-indexer) NeeruPositionDetail from a deposit
// receipt on chain. The wallet POSTs the tx hash right after a successful
// deposit to render an optimistic position card while the backend indexer
// catches up. Once the indexer picks the same positionId up, the real
// (non-provisional) record from GET /api/earn/neeru/positions supersedes
// this response and the `provisional` flag disappears.

import { decodeAbiParameters, hexToBigInt } from 'viem'
import type { PublicClient } from 'viem'
import { decimalString } from '../../lib/decimal'
import { CONTRACT_ADDRESS } from '../../neeru-indexer/abi'
import type {
  CurrentPayoutIfClosed,
  NeeruPositionDetail,
} from './detail'
import { monthlyYieldPercent } from './positions'

const SECONDS_PER_DAY = 86_400

// Non-indexed args on the deposit event's log.data, types-only. Two
// indexed args live in topics[1]/topics[2] and are decoded separately
// via hexToBigInt on the raw topic bytes. Four positional slots follow
// the r0..r3 opaque convention used elsewhere in this repo; consumers
// index by position, never by name.
const DEPOSIT_EVENT_DATA_SCHEMA = [
  { type: 'uint8' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
] as const

export interface ProvisionalPositionResponse {
  address: string
  position: NeeruPositionDetail & { provisional: true }
}

export type NotifyOutcome =
  | { kind: 'ok'; response: ProvisionalPositionResponse }
  | { kind: 'invalid_body'; error: string }
  | { kind: 'not_configured'; error: string }
  | { kind: 'wrong_address'; error: string }
  | { kind: 'not_deposit'; error: string }
  | { kind: 'not_found'; error: string }
  | { kind: 'rpc_error'; error: string }

export interface BuildProvisionalArgs {
  address: string
  txHash: string
  client: PublicClient
  categorySecs: (category: number) => bigint | null
  // Per-category daily rate as a RAY scalar, used only to compute the
  // display-only monthlyRatePercentage on the provisional response.
  // Returns null when the category is unknown; the response then emits
  // monthlyRatePercentage: 0 and the wallet supersedes when the indexer
  // surfaces the real per-position frozen value.
  categoryRateRay: (category: number) => bigint | null
  depositDecimals: number
}

export async function buildProvisionalDeposit(
  args: BuildProvisionalArgs,
): Promise<NotifyOutcome> {
  // Read process.env directly (rather than via the zod-frozen env proxy)
  // so tests can flip the value at runtime. The value is validated as a
  // 66-char 0x-prefixed hex string when set on Railway; here we only
  // check presence + the topic0 length used for log.topic[0] matching.
  const eventTopic0 = process.env.NEERU_DEPOSIT_EVENT_TOPIC0
  if (!eventTopic0) {
    return {
      kind: 'not_configured',
      error: 'NEERU_DEPOSIT_EVENT_TOPIC0 not set',
    }
  }
  const contractAddressLower = CONTRACT_ADDRESS.toLowerCase()

  let receipt
  try {
    receipt = await args.client.getTransactionReceipt({
      hash: args.txHash as `0x${string}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not\s*found|could not be found/i.test(msg)) {
      return { kind: 'not_found', error: 'tx not mined yet' }
    }
    return { kind: 'rpc_error', error: msg }
  }

  if (receipt.status !== 'success') {
    return { kind: 'not_deposit', error: 'tx reverted' }
  }

  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === contractAddressLower &&
      l.topics[0]?.toLowerCase() === eventTopic0.toLowerCase(),
  )
  if (!log || !log.topics[1] || !log.topics[2]) {
    return {
      kind: 'not_deposit',
      error: 'no matching event on the configured contract',
    }
  }

  // topics[1] = indexed depositor address, zero-padded to 32 bytes.
  // Verify it matches the caller so the wallet cannot notify about a
  // tx that belongs to someone else.
  const eventDepositor = ('0x' + log.topics[1].slice(-40)).toLowerCase()
  if (eventDepositor !== args.address.toLowerCase()) {
    return {
      kind: 'wrong_address',
      error: 'address does not match event depositor',
    }
  }

  const [r0, r1, r2, r3] = decodeAbiParameters(
    DEPOSIT_EVENT_DATA_SCHEMA,
    log.data,
  )
  const category = Number(r0 as number)
  const amountWei = r1 as bigint
  const startTs = Number(r2 as bigint)
  const endTsRaw = Number(r3 as bigint)

  const positionIdBn = hexToBigInt(log.topics[2] as `0x${string}`)
  const positionId = positionIdBn.toString()

  // r3 == 0 signifies no lock window; fall back to startTs so wallet
  // renderers that expect endTs >= startTs stay happy.
  const endTs = endTsRaw > 0 ? endTsRaw : startTs

  // Category window secs (from the cached catalogue) is used only for
  // the human label ("Flexible" / "N dias"). Missing entry falls back
  // to the r3-derived duration; unknown category renders as flexible.
  const secs = args.categorySecs(category)
  const derivedSecs =
    secs ?? (endTsRaw > startTs ? BigInt(endTsRaw - startTs) : 0n)
  const amountStr = decimalString(amountWei, args.depositDecimals)
  const categoryLabel =
    derivedSecs === 0n
      ? 'Flexible'
      : `${Number(derivedSecs / BigInt(SECONDS_PER_DAY))} dias`

  // The event does not carry the per-position frozen rate, so we fall
  // back to the current per-category rate from the cached catalogue for
  // the display-only monthlyRatePercentage on the provisional response.
  // The wallet supersedes this once the indexer surfaces the real value.
  const rateRay = args.categoryRateRay(category)
  const monthly = rateRay != null ? monthlyYieldPercent(rateRay) : 0

  const payout: CurrentPayoutIfClosed = {
    amount: amountStr,
    interest: '0',
    penaltyBps: 0,
    interestAfterPenalty: '0',
    total: amountStr,
    isEarly: false,
  }

  const position: NeeruPositionDetail & { provisional: true } = {
    positionId,
    category,
    categoryLabel,
    amount: amountStr,
    accruedInterest: '0',
    monthlyRatePercentage: monthly,
    startTs,
    endTs,
    depositBlock: Number(receipt.blockNumber),
    depositTxHash: receipt.transactionHash,
    renewedFromPositionId: null,
    currentPayoutIfClosed: payout,
    provisional: true,
  }

  return {
    kind: 'ok',
    response: {
      address: args.address.toLowerCase(),
      position,
    },
  }
}
