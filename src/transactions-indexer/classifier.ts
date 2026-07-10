import { env } from '../lib/env'
import {
  decimalizeValueForClassifier,
  decimalsForTokenId,
  resolveFeeCurrency,
  weiToDecimal,
} from './priceOracle'
import type {
  ApprovalTransaction,
  ClassifierLog,
  ClassifierTx,
  EarnTransaction,
  NetworkId,
  SwapTransaction,
  TokenAmount,
  TokenTransaction,
  TransferTransaction,
  TxTerminalStatus,
} from './types'

// ERC20 event topic0s (keccak256 of event signature).
const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// 4-byte selectors (first 8 hex chars after 0x).
const SELECTOR_APPROVE = '0x095ea7b3' // approve(address,uint256)
// OpenZeppelin non-standard `increaseAllowance(address,uint256)`. Same
// calldata shape as approve (spender at word 0). CELO ERC20 emits only
// an Approval event with no Transfer log, so the backfill's Transfer
// scan misses it; recognising the selector here lets the tx render as
// APPROVAL when it lands via the live worker's direct-touch path.
// Added 2026-07-10 after the wallet team's diff surfaced 3 spike v2
// txs (0x0bf68b67, 0x765409c9, 0xd3893900) that our classifier was
// dropping. `decreaseAllowance` intentionally omitted: emitting it as
// APPROVAL would be misleading (it revokes) and Valora's renderer
// does not surface it either.
const SELECTOR_INCREASE_ALLOWANCE = '0x39509351'
const SELECTOR_TRANSFER = '0xa9059cbb' // transfer(address,uint256)
const SELECTOR_TRANSFER_FROM = '0x23b872dd' // transferFrom(address,address,uint256)

// EIP-7702 BatchExecutor at 0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe.
// Plan rule 1 keys off `tx.from == tx.to == userEOA` plus this selector.
// Selector is keccak256("execute((address,uint256,bytes)[])")[:10]; confirmed
// against the BatchExecutor ABI and the real 7702 tx
// 0xbefe73327f874c2e60ef95939499ecbb72c2a61478eb20f011ff9e4d745be5d8.
const SELECTOR_EXECUTE = '0x3f707e6b'

// Known aggregator entry points (tx.to when the user calls the aggregator
// directly). Used by classifyAggregatorSwap to recognize routes where the
// counterparty pattern in Transfer logs does NOT go through a single
// intermediary (e.g. Squid fundAndRunMulticall routes through multiple
// Mento pools; outbound counterparty = pool A, inbound = pool B, they
// do not intersect). Confirmed via the wallet team's diff runner
// 2026-07-08: tx 0x28d17073... spike v2 -> Squid Router 0xce16f6.. with
// outbound COPm to 0xad6cea45.. and inbound USDC from 0x34757893..
const KNOWN_AGGREGATOR_TARGETS: ReadonlySet<string> = new Set([
  '0xce16f69375520ab01377ce7b88f5ba8c48f8d666', // Squid Router (Celo)
])

function isKnownAggregatorTarget(to: string | null): boolean {
  return to != null && KNOWN_AGGREGATOR_TARGETS.has(to.toLowerCase())
}

// CELO is an ERC20 with its own contract (0x471E...A438), not a chain-native
// sentinel. The wallet's token registry only knows the contract id, so a
// `celo-mainnet:native` sentinel would render as an unknown token.
const NATIVE_TOKEN_ID = 'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438'

function tokenIdForContract(networkId: NetworkId, contract: string): string {
  return `${networkId}:${contract.toLowerCase()}`
}

// Build a TokenAmount with `value` already decimalised via the canonical
// registry. Unknown tokens surface `decimals: null` + the raw wei value so
// the wallet can still render "unknown token" without silently displaying
// a mis-scaled number. See src/transactions-indexer/priceOracle.ts.
function makeAmount(tokenId: string, rawWei: bigint): TokenAmount {
  return {
    tokenId,
    value: decimalizeValueForClassifier(rawWei, tokenId),
    decimals: decimalsForTokenId(tokenId),
  }
}

function deriveStatus(tx: ClassifierTx): TxTerminalStatus {
  return tx.status === 'success' ? 'Complete' : 'Failed'
}

function topicToAddress(topic: string | null): string | null {
  if (!topic || topic.length !== 66) return null
  return `0x${topic.slice(26).toLowerCase()}`
}

function selectorOf(input: string): string {
  if (!input.startsWith('0x') || input.length < 10) return '0x'
  return input.slice(0, 10).toLowerCase()
}

function isExecuteSelector(input: string): boolean {
  return selectorOf(input) === SELECTOR_EXECUTE
}

function decodeUint256(hexNoPrefix: string): bigint {
  if (!hexNoPrefix) return 0n
  return BigInt('0x' + hexNoPrefix)
}

function decodeAddress(word: string): string {
  // word is a 32-byte hex chunk (64 hex chars); address is last 20 bytes.
  return `0x${word.slice(-40).toLowerCase()}`
}

function calldataWords(input: string): string[] {
  if (input.length <= 10) return []
  const body = input.slice(10)
  const out: string[] = []
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(body.slice(i, i + 64))
  }
  return out
}

function buildFee(tx: ClassifierTx, networkId: NetworkId): TokenAmount[] {
  if (tx.gasUsed == null || tx.effectiveGasPrice == null) return []
  const feeRawWei = tx.gasUsed * tx.effectiveGasPrice
  // resolveFeeCurrency: handles CIP-64 semantics -> when tx.feeCurrency
  // points at an adapter (USDC / USDT), returns the underlying token id +
  // downshifted rawWei so the wallet renders "N USDC" instead of the
  // adapter address. See priceOracle.ts for the full explanation.
  const resolved = resolveFeeCurrency(tx.feeCurrency, feeRawWei, networkId)
  return [
    {
      tokenId: resolved.tokenId,
      value: weiToDecimal(resolved.rawWei.toString(), resolved.decimals, { padded: true }),
      decimals: resolved.decimals,
    },
  ]
}

function baseFields(tx: ClassifierTx, userAddress: string) {
  return {
    networkId: tx.networkId,
    transactionHash: tx.hash.toLowerCase(),
    timestamp: tx.blockTimestampMs,
    block: tx.blockNumber.toString(),
    address: userAddress.toLowerCase(),
    status: deriveStatus(tx),
    fees: buildFee(tx, tx.networkId).map((amount) => ({
      type: 'SECURITY_FEE' as const,
      amount,
    })),
  }
}

interface TransferMovement {
  contract: string
  from: string
  to: string
  value: bigint
}

function decodeTransferLogs(logs: ClassifierLog[]): TransferMovement[] {
  const out: TransferMovement[] = []
  for (const log of logs) {
    if (log.topic0 !== ERC20_TRANSFER_TOPIC0) continue
    const from = topicToAddress(log.topic1)
    const to = topicToAddress(log.topic2)
    if (!from || !to) continue
    const value = decodeUint256(log.data.startsWith('0x') ? log.data.slice(2) : log.data)
    out.push({
      contract: log.contract.toLowerCase(),
      from,
      to,
      value,
    })
  }
  return out
}

function aggregateByToken(movements: TransferMovement[]): Map<string, bigint> {
  const acc = new Map<string, bigint>()
  for (const m of movements) {
    acc.set(m.contract, (acc.get(m.contract) ?? 0n) + m.value)
  }
  return acc
}

function pickHighest(amounts: Map<string, bigint>): { contract: string; value: bigint } | null {
  let best: { contract: string; value: bigint } | null = null
  for (const [contract, value] of amounts) {
    if (best === null || value > best.value) {
      best = { contract, value }
    }
  }
  return best
}

// Bug fix 2026-07-05 (see JOURNAL): pickHighest compares raw bigint, so a
// USDm -> COPm swap where the Mento fee adapter pre-charges + refunds a
// COPm amount larger (in raw wei) than the swapped USDm confuses the raw
// pick and both `inAmount` and `outAmount` come out as COPm.
//
// This helper strips tokens that appear on BOTH sides (round-trip / fees /
// mirror mint+burn patterns) from each aggregate before pickHighest runs.
// If a side ends up empty after the strip, we fall back to its full set so
// pathological round-trips are still classified rather than dropped.
function stripRoundTripTokens(
  soldByToken: Map<string, bigint>,
  receivedByToken: Map<string, bigint>,
): { sold: Map<string, bigint>; received: Map<string, bigint> } {
  const sold = new Map(soldByToken)
  const received = new Map(receivedByToken)
  const shared: string[] = []
  for (const token of soldByToken.keys()) {
    if (receivedByToken.has(token)) shared.push(token)
  }
  for (const token of shared) {
    sold.delete(token)
    received.delete(token)
  }
  return {
    sold: sold.size > 0 ? sold : soldByToken,
    received: received.size > 0 ? received : receivedByToken,
  }
}

// Bug fix 2026-07-06 (see JOURNAL): the previous classifier summed every
// Transfer log where the user was `from` into `outAmount` (and every
// Transfer where the user was `to` into `inAmount`). That "net actual
// outbound" convention emits the sum of the swap leg + burns + fees +
// mirror-mint refunds, and diverged from Valora's "swap intent" number by
// the total of the non-swap movements. Wallet team went with option B
// (Valora-shape, swap-leg only) so users comparing feed screenshots
// against their Valora history see the same amounts.
//
// A movement is a "swap leg" iff the counterparty (the `to` for outbound,
// the `from` for inbound) has an opposite-direction movement with the user
// in a DIFFERENT token contract. That excludes:
//
//   - Fee sink outbound: no matching inbound from the fee sink.
//   - Aggregator fee outbound: no matching inbound.
//   - Mirror burn+mint refund: outbound to 0x0 pairs with an inbound from
//     0x0, but they're the SAME token so it's not a swap leg.
//
// Falls back to the unfiltered sets when the filter would empty either
// side, so pathological txs (e.g. transfers detected by aggregator swap's
// counterparty-intersect heuristic that don't literally have paired
// swaps) still classify rather than silently drop.
function filterToSwapLegs(
  outbound: TransferMovement[],
  inbound: TransferMovement[],
): { swapOutbound: TransferMovement[]; swapInbound: TransferMovement[] } {
  const outboundTokensAtCounterparty = new Map<string, Set<string>>()
  for (const m of outbound) {
    let set = outboundTokensAtCounterparty.get(m.to)
    if (!set) {
      set = new Set()
      outboundTokensAtCounterparty.set(m.to, set)
    }
    set.add(m.contract)
  }
  const inboundTokensAtCounterparty = new Map<string, Set<string>>()
  for (const m of inbound) {
    let set = inboundTokensAtCounterparty.get(m.from)
    if (!set) {
      set = new Set()
      inboundTokensAtCounterparty.set(m.from, set)
    }
    set.add(m.contract)
  }

  const swapOutbound: TransferMovement[] = []
  for (const m of outbound) {
    const inboundTokens = inboundTokensAtCounterparty.get(m.to)
    if (!inboundTokens) continue
    for (const t of inboundTokens) {
      if (t !== m.contract) {
        swapOutbound.push(m)
        break
      }
    }
  }

  const swapInbound: TransferMovement[] = []
  for (const m of inbound) {
    const outboundTokens = outboundTokensAtCounterparty.get(m.from)
    if (!outboundTokens) continue
    for (const t of outboundTokens) {
      if (t !== m.contract) {
        swapInbound.push(m)
        break
      }
    }
  }

  return {
    swapOutbound: swapOutbound.length > 0 ? swapOutbound : outbound,
    swapInbound: swapInbound.length > 0 ? swapInbound : inbound,
  }
}

function classify7702Atomic(
  tx: ClassifierTx,
  logs: ClassifierLog[],
  userAddress: string,
): SwapTransaction | null {
  const userLower = userAddress.toLowerCase()
  const sameSelf = tx.from.toLowerCase() === userLower && tx.to?.toLowerCase() === userLower
  if (!sameSelf) return null
  if (!isExecuteSelector(tx.input)) return null

  const transfers = decodeTransferLogs(logs)
  const rawSold = transfers.filter((m) => m.from === userLower)
  const rawReceived = transfers.filter((m) => m.to === userLower)
  if (rawSold.length === 0 && rawReceived.length === 0) return null

  // Option B (swap-leg-only) per wallet team decision 2026-07-06. Fees,
  // burns, and mirror mint refunds are excluded from both inAmount /
  // outAmount and from fromTokenAmounts[].
  const { swapOutbound, swapInbound } = filterToSwapLegs(rawSold, rawReceived)
  const soldByToken = aggregateByToken(swapOutbound)
  const receivedByToken = aggregateByToken(swapInbound)

  const fromTokenAmounts: TokenAmount[] = []
  for (const [contract, value] of soldByToken) {
    fromTokenAmounts.push(makeAmount(tokenIdForContract(tx.networkId, contract), value))
  }

  const { sold: soldPrimary, received: receivedPrimary } = stripRoundTripTokens(
    soldByToken,
    receivedByToken,
  )
  const highestSold = pickHighest(soldPrimary)
  const highestReceived = pickHighest(receivedPrimary)
  if (!highestSold || !highestReceived) return null

  return {
    ...baseFields(tx, userAddress),
    type: 'SWAP_TRANSACTION',
    inAmount: makeAmount(
      tokenIdForContract(tx.networkId, highestReceived.contract),
      highestReceived.value,
    ),
    outAmount: makeAmount(
      tokenIdForContract(tx.networkId, highestSold.contract),
      highestSold.value,
    ),
    fromTokenAmounts: fromTokenAmounts.length > 1 ? fromTokenAmounts : undefined,
  }
}

function classifyAggregatorSwap(
  tx: ClassifierTx,
  logs: ClassifierLog[],
  userAddress: string,
): SwapTransaction | null {
  // Plan rule 2: detect a swap when the user's tx moves at least one token
  // OUT of the wallet and receives at least one different token back.
  //
  // Two paths:
  //   1) Same-counterparty (Uniswap-style single pool, some legacy Squid
  //      routes): outboundCounterparty == inboundCounterparty. Kept as the
  //      original heuristic so any router follows this pattern is treated
  //      as a swap without needing a hardcoded address.
  //   2) Known aggregator target (Squid Router fundAndRunMulticall, other
  //      multi-hop aggregators): routing goes through multiple pools with
  //      NO shared counterparty in the Transfer logs. Added 2026-07-08
  //      after the wallet team's diff runner surfaced 4 fundAndRunMulticall
  //      txs missing from /feed because path (1) failed. See
  //      KNOWN_AGGREGATOR_TARGETS above.
  const userLower = userAddress.toLowerCase()
  if (tx.from.toLowerCase() !== userLower) return null

  const transfers = decodeTransferLogs(logs)
  const outbound = transfers.filter((m) => m.from === userLower)
  const inbound = transfers.filter((m) => m.to === userLower)
  if (outbound.length === 0 || inbound.length === 0) return null

  const aggregatorTarget = isKnownAggregatorTarget(tx.to)
  if (!aggregatorTarget) {
    // Path 1: require the same intermediary for the outbound and inbound
    // legs. Legacy behaviour; do not weaken for unknown routers to avoid
    // false-positives on random contracts that happen to move both ways.
    const outboundCounterparties = new Set(outbound.map((m) => m.to))
    const inboundCounterparties = new Set(inbound.map((m) => m.from))
    const intersect = [...outboundCounterparties].filter((a) =>
      inboundCounterparties.has(a),
    )
    if (intersect.length === 0) return null
  }

  // Option B: swap-leg-only filter (same rationale as classify7702Atomic).
  const { swapOutbound, swapInbound } = filterToSwapLegs(outbound, inbound)
  const outboundSum = aggregateByToken(swapOutbound)
  const inboundSum = aggregateByToken(swapInbound)

  // Require the in and out tokens to be different; otherwise this is just a
  // self round-trip and not a swap.
  const outTokens = [...outboundSum.keys()]
  const inTokens = [...inboundSum.keys()]
  if (outTokens.length === 1 && inTokens.length === 1 && outTokens[0] === inTokens[0]) {
    return null
  }

  const { sold: outboundPrimary, received: inboundPrimary } = stripRoundTripTokens(
    outboundSum,
    inboundSum,
  )
  const highestOut = pickHighest(outboundPrimary)
  const highestIn = pickHighest(inboundPrimary)
  if (!highestOut || !highestIn) return null

  return {
    ...baseFields(tx, userAddress),
    type: 'SWAP_TRANSACTION',
    inAmount: makeAmount(tokenIdForContract(tx.networkId, highestIn.contract), highestIn.value),
    outAmount: makeAmount(tokenIdForContract(tx.networkId, highestOut.contract), highestOut.value),
  }
}

function classifyApprove(
  tx: ClassifierTx,
  userAddress: string,
): ApprovalTransaction | null {
  if (tx.from.toLowerCase() !== userAddress.toLowerCase()) return null
  const selector = selectorOf(tx.input)
  if (selector !== SELECTOR_APPROVE && selector !== SELECTOR_INCREASE_ALLOWANCE) {
    return null
  }
  const [spenderWord] = calldataWords(tx.input)
  if (!spenderWord) return null
  return {
    ...baseFields(tx, userAddress),
    type: 'APPROVAL',
    approvedAddress: decodeAddress(spenderWord),
    tokenId: tx.to ? tokenIdForContract(tx.networkId, tx.to) : NATIVE_TOKEN_ID,
  }
}

function classifyErc20Transfer(
  tx: ClassifierTx,
  userAddress: string,
): TransferTransaction | null {
  const userLower = userAddress.toLowerCase()
  if (tx.from.toLowerCase() !== userLower) return null
  const sel = selectorOf(tx.input)
  if (sel !== SELECTOR_TRANSFER && sel !== SELECTOR_TRANSFER_FROM) return null

  const words = calldataWords(tx.input)
  if (sel === SELECTOR_TRANSFER) {
    const [toWord, valueWord] = words
    if (!toWord || !valueWord) return null
    const tokenId = tx.to ? tokenIdForContract(tx.networkId, tx.to) : NATIVE_TOKEN_ID
    return {
      ...baseFields(tx, userAddress),
      type: 'SENT',
      amount: makeAmount(tokenId, decodeUint256(valueWord)),
      address: decodeAddress(toWord),
    }
  }
  if (sel === SELECTOR_TRANSFER_FROM) {
    const [fromWord, toWord, valueWord] = words
    if (!fromWord || !toWord || !valueWord) return null
    const from = decodeAddress(fromWord)
    const to = decodeAddress(toWord)
    const value = decodeUint256(valueWord)
    const isSent = from === userLower
    const tokenId = tx.to ? tokenIdForContract(tx.networkId, tx.to) : NATIVE_TOKEN_ID
    return {
      ...baseFields(tx, userAddress),
      type: isSent ? 'SENT' : 'RECEIVED',
      amount: makeAmount(tokenId, value),
      address: isSent ? to : from,
    }
  }
  return null
}

function classifyNativeSend(
  tx: ClassifierTx,
  userAddress: string,
): TransferTransaction | null {
  if (tx.from.toLowerCase() !== userAddress.toLowerCase()) return null
  if (tx.valueWei <= 0n) return null
  if (!tx.to) return null
  if (tx.to.toLowerCase() === userAddress.toLowerCase()) return null
  return {
    ...baseFields(tx, userAddress),
    type: 'SENT',
    amount: makeAmount(NATIVE_TOKEN_ID, tx.valueWei),
    address: tx.to.toLowerCase(),
  }
}

function classifyReceiveFromLog(
  tx: ClassifierTx,
  logs: ClassifierLog[],
  userAddress: string,
): TransferTransaction | null {
  const userLower = userAddress.toLowerCase()
  // Only when user is NOT the originator; user-initiated tx are handled by
  // the earlier rules. This avoids double-counting swap legs as receives.
  if (tx.from.toLowerCase() === userLower) return null

  const transfers = decodeTransferLogs(logs)
  const received = transfers.filter((m) => m.to === userLower)
  if (received.length === 0) return null

  // Aggregate by token; surface the largest received as the canonical leg.
  const byToken = aggregateByToken(received)
  const top = pickHighest(byToken)
  if (!top) return null

  // address = the original sender (the counterparty for display).
  const firstSender = received[0]?.from ?? tx.from.toLowerCase()

  return {
    ...baseFields(tx, userAddress),
    type: 'RECEIVED',
    amount: makeAmount(tokenIdForContract(tx.networkId, top.contract), top.value),
    address: firstSender,
  }
}

// Earn / Neeru event classification (added 2026-07-06 to close the "Neeru
// txs disappear from the timeline" gap the wallet team flagged). Neeru's
// contract emits four events; the parser at `src/neeru-indexer/parser.ts`
// tags them Kind A/B/C/D. From on-chain semantics:
//   Kind A = new position opened -> DEPOSIT
//   Kind B = position closed (early withdrawal) -> WITHDRAW
//   Kind C = position closed at maturity -> CLAIM_REWARD
//   Kind D = renew / compound (skipped for MVP; future SWAP-like semantics)
// The mapping is env-driven so an adapter-only tweak (e.g. a new Neeru
// event added later) can be wired via config, not a code change.
type EarnAction = 'DEPOSIT' | 'WITHDRAW' | 'CLAIM_REWARD'

interface EarnEventBinding {
  appId: string
  // Human-readable protocol label shown in the wallet timeline (Valora
  // renderer reads `appName` directly and falls back to i18n placeholder
  // when undefined). Kept as a small in-source registry: the set of active
  // Earn protocols grows one at a time, adding a hard-coded label per new
  // integration is a two-line change and avoids threading yet another env
  // var per protocol.
  appName: string
  contract: string
  actionByTopic0: Record<string, EarnAction>
  // Optional deposit token restriction for the amount match. When null the
  // classifier accepts any ERC20 Transfer that matches the direction.
  depositToken: string | null
}

function loadEarnRegistry(): EarnEventBinding[] {
  const out: EarnEventBinding[] = []
  const neeruContract = env.NEERU_CONTRACT_ADDRESS
  if (neeruContract) {
    const map: Record<string, EarnAction> = {}
    if (env.NEERU_EVENT_A_TOPIC0) map[env.NEERU_EVENT_A_TOPIC0.toLowerCase()] = 'DEPOSIT'
    if (env.NEERU_EVENT_B_TOPIC0) map[env.NEERU_EVENT_B_TOPIC0.toLowerCase()] = 'WITHDRAW'
    if (env.NEERU_EVENT_C_TOPIC0) map[env.NEERU_EVENT_C_TOPIC0.toLowerCase()] = 'CLAIM_REWARD'
    if (Object.keys(map).length > 0) {
      out.push({
        appId: 'neeru-vaults',
        appName: 'Neeru Vaults',
        contract: neeruContract.toLowerCase(),
        actionByTopic0: map,
        depositToken: env.NEERU_DEPOSIT_TOKEN_ADDRESS
          ? env.NEERU_DEPOSIT_TOKEN_ADDRESS.toLowerCase()
          : null,
      })
    }
  }
  return out
}

let cachedEarnRegistry: EarnEventBinding[] | null = null
function earnRegistry(): EarnEventBinding[] {
  if (cachedEarnRegistry === null) cachedEarnRegistry = loadEarnRegistry()
  return cachedEarnRegistry
}

export function _resetEarnRegistryForTests(): void {
  cachedEarnRegistry = null
}

function classifyEarnFromLogs(
  tx: ClassifierTx,
  logs: ClassifierLog[],
  userAddress: string,
): EarnTransaction | null {
  const userLower = userAddress.toLowerCase()
  const paddedUser = '0x' + '0'.repeat(24) + userLower.slice(2)
  const registry = earnRegistry()
  if (registry.length === 0) return null

  let match: {
    binding: EarnEventBinding
    action: EarnAction
    positionId: string | null
  } | null = null
  for (const log of logs) {
    const contract = log.contract.toLowerCase()
    const binding = registry.find((b) => b.contract === contract)
    if (!binding) continue
    const action = binding.actionByTopic0[log.topic0.toLowerCase()]
    if (!action) continue
    // topic1 = indexed user address. Match ours (case-insensitive padded).
    if (log.topic1 && log.topic1.toLowerCase() !== paddedUser) continue
    // topic2 = indexed position id (uint256). Decode for the emit.
    let positionId: string | null = null
    if (log.topic2) {
      try {
        positionId = BigInt(log.topic2).toString()
      } catch {
        positionId = null
      }
    }
    match = { binding, action, positionId }
    break
  }
  if (!match) return null

  // Amount = the ERC20 Transfer that moved the deposit token between the
  // user and the earn contract. For DEPOSIT that's user -> anywhere; for
  // WITHDRAW / CLAIM_REWARD it's anywhere -> user.
  const transfers = decodeTransferLogs(logs)
  let amountRaw: bigint | null = null
  let tokenContract: string | null = null
  const preferred = match.binding.depositToken
  for (const t of transfers) {
    const okDirection =
      match.action === 'DEPOSIT' ? t.from === userLower : t.to === userLower
    if (!okDirection) continue
    if (preferred && t.contract !== preferred) continue
    amountRaw = t.value
    tokenContract = t.contract
    break
  }
  // If a preferred deposit token was set but no matching Transfer was
  // found, fall back to any Transfer in the correct direction rather than
  // dropping the whole tx from the feed.
  if (amountRaw === null && preferred) {
    for (const t of transfers) {
      const okDirection =
        match.action === 'DEPOSIT' ? t.from === userLower : t.to === userLower
      if (!okDirection) continue
      amountRaw = t.value
      tokenContract = t.contract
      break
    }
  }
  if (amountRaw === null || tokenContract === null) return null

  const amount = makeAmount(tokenIdForContract(tx.networkId, tokenContract), amountRaw)
  // Populate both `inAmount` and `outAmount` with the same TokenAmount.
  // Valora's renderer branches by `type` and reads only one of the two:
  // DEPOSIT reads `outAmount`, WITHDRAW / CLAIM_REWARD read `inAmount`.
  // Duplicating both is cheap (one shared reference) and guards against
  // any renderer branch reading the "wrong" field. See EarnTransaction
  // interface comment in ./types.ts for the wire-shape rationale.
  return {
    ...baseFields(tx, userAddress),
    type: match.action,
    appName: match.binding.appName,
    inAmount: amount,
    outAmount: amount,
    appId: match.binding.appId,
    positionId: match.positionId,
    amount,
  }
}

export function classify(
  tx: ClassifierTx,
  logs: ClassifierLog[],
  userAddress: string,
): TokenTransaction[] {
  // Reverted txs are still emitted (status: "Failed") so the wallet timeline
  // shows the attempt. Pre-2026-07-05 they were silently dropped, which hid
  // failed swaps from the user. Consumers should key badge colour / retry
  // logic off `status` at the top level.

  // Rules are applied in plan order; the first matching rule wins. Earn
  // events run BEFORE the swap heuristics: a Neeru deposit tx also has a
  // COPm Transfer out of the user, which classify7702Atomic /
  // classifyAggregatorSwap would otherwise fold into a bogus swap.
  const earn = classifyEarnFromLogs(tx, logs, userAddress)
  if (earn) return [earn]

  const r1 = classify7702Atomic(tx, logs, userAddress)
  if (r1) return [r1]

  const r2 = classifyAggregatorSwap(tx, logs, userAddress)
  if (r2) return [r2]

  const r3 = classifyApprove(tx, userAddress)
  if (r3) return [r3]

  const r4 = classifyErc20Transfer(tx, userAddress)
  if (r4) return [r4]

  const r5 = classifyNativeSend(tx, userAddress)
  if (r5) return [r5]

  const r6 = classifyReceiveFromLog(tx, logs, userAddress)
  if (r6) return [r6]

  // Rule 7 (earn vaults: deposit/withdraw/claimReward) is deferred to a
  // later phase; rule 8 is the documented omit-by-default fallback.
  return []
}
