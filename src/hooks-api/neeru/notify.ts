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

// Non-indexed args on the deployed Deposit event, positional (types only,
// no names) matching the wallet's own DEPOSIT_EVENT_DATA_SCHEMA from PR
// #265. Order: (category, amount, rateValue). depositor + positionId
// are the two indexed args (topics[1], topics[2]).
const DEPOSIT_EVENT_DATA_SCHEMA = [
  { type: 'uint8' },
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
  depositDecimals: number
}

export async function buildProvisionalDeposit(
  args: BuildProvisionalArgs,
): Promise<NotifyOutcome> {
  // Read process.env directly (rather than via the zod-frozen env proxy)
  // so tests can flip the value at runtime. The value is validated as a
  // 66-char 0x-prefixed hex string when set on Railway; here we only
  // check presence + the topic0 length used for log.topic[0] matching.
  const depositTopic0 = process.env.NEERU_DEPOSIT_EVENT_TOPIC0
  if (!depositTopic0) {
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
      l.topics[0]?.toLowerCase() === depositTopic0.toLowerCase(),
  )
  if (!log || !log.topics[1] || !log.topics[2]) {
    return {
      kind: 'not_deposit',
      error: 'no Deposit event on the earn-vault contract',
    }
  }

  // topics[1] = depositor (indexed address), zero-padded to 32 bytes.
  // Verify it matches the caller so the wallet cannot notify about a tx
  // that belongs to someone else.
  const eventDepositor = ('0x' + log.topics[1].slice(-40)).toLowerCase()
  if (eventDepositor !== args.address.toLowerCase()) {
    return {
      kind: 'wrong_address',
      error: 'address does not match Deposit event depositor',
    }
  }

  const [categoryRaw, amountRaw, rateRaw] = decodeAbiParameters(
    DEPOSIT_EVENT_DATA_SCHEMA,
    log.data,
  )
  const category = Number(categoryRaw as number)
  const amountWei = amountRaw as bigint
  const rateValue = rateRaw as bigint

  const positionIdBn = hexToBigInt(log.topics[2] as `0x${string}`)
  const positionId = positionIdBn.toString()

  // Block timestamp comes from the block header; the receipt itself does
  // not carry it. One extra RPC call, still cheap on the notify path.
  let blockTimestamp: bigint
  try {
    const block = await args.client.getBlock({
      blockNumber: receipt.blockNumber,
      includeTransactions: false,
    })
    blockTimestamp = block.timestamp
  } catch (err) {
    return {
      kind: 'rpc_error',
      error: `getBlock failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const startTs = Number(blockTimestamp)
  const secs = args.categorySecs(category)
  // secs = 0n signifies the flexible category (no lock window). Any lock
  // gives endTs = startTs + window secs; flexible stays at startTs.
  const endTs =
    secs != null && secs > 0n ? startTs + Number(secs) : startTs

  const amountStr = decimalString(amountWei, args.depositDecimals)
  const monthly = monthlyYieldPercent(rateValue)
  const categoryLabel = secs === 0n ? 'Flexible' : `${Number((secs ?? 0n) / BigInt(SECONDS_PER_DAY))} dias`

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
