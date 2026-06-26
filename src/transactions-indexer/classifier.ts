import type {
  ApprovalTransaction,
  ClassifierLog,
  ClassifierTx,
  NetworkId,
  SwapTransaction,
  TokenAmount,
  TokenTransaction,
  TransferTransaction,
} from './types'

// ERC20 event topic0s (keccak256 of event signature).
const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// 4-byte selectors (first 8 hex chars after 0x).
const SELECTOR_APPROVE = '0x095ea7b3' // approve(address,uint256)
const SELECTOR_TRANSFER = '0xa9059cbb' // transfer(address,uint256)
const SELECTOR_TRANSFER_FROM = '0x23b872dd' // transferFrom(address,address,uint256)

// EIP-7702 BatchExecutor at 0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe.
// Plan rule 1 keys off `tx.from == tx.to == userEOA` plus this selector.
// Selector is keccak256("execute((address,uint256,bytes)[])")[:10]; confirmed
// against the BatchExecutor ABI and the real 7702 tx
// 0xbefe73327f874c2e60ef95939499ecbb72c2a61478eb20f011ff9e4d745be5d8.
const SELECTOR_EXECUTE = '0x3f707e6b'

// CELO is an ERC20 with its own contract (0x471E...A438), not a chain-native
// sentinel. The wallet's token registry only knows the contract id, so a
// `celo-mainnet:native` sentinel would render as an unknown token.
const NATIVE_TOKEN_ID = 'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438'

function tokenIdForContract(networkId: NetworkId, contract: string): string {
  return `${networkId}:${contract.toLowerCase()}`
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
  const feeValue = (tx.gasUsed * tx.effectiveGasPrice).toString()
  const tokenId = tx.feeCurrency
    ? tokenIdForContract(networkId, tx.feeCurrency)
    : NATIVE_TOKEN_ID
  return [{ tokenId, value: feeValue }]
}

function baseFields(tx: ClassifierTx, userAddress: string) {
  return {
    networkId: tx.networkId,
    transactionHash: tx.hash.toLowerCase(),
    timestamp: tx.blockTimestampMs,
    block: tx.blockNumber.toString(),
    address: userAddress.toLowerCase(),
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
  // "Sold" tokens = user is the from of the Transfer.
  // "Received" tokens = user is the to of the Transfer.
  const sold = transfers.filter((m) => m.from === userLower)
  const received = transfers.filter((m) => m.to === userLower)
  if (sold.length === 0 && received.length === 0) return null

  const soldByToken = aggregateByToken(sold)
  const receivedByToken = aggregateByToken(received)

  const fromTokenAmounts: TokenAmount[] = []
  for (const [contract, value] of soldByToken) {
    fromTokenAmounts.push({
      tokenId: tokenIdForContract(tx.networkId, contract),
      value: value.toString(),
    })
  }

  const highestSold = pickHighest(soldByToken)
  const highestReceived = pickHighest(receivedByToken)
  if (!highestSold || !highestReceived) return null

  return {
    ...baseFields(tx, userAddress),
    type: 'SWAP_TRANSACTION',
    inAmount: {
      tokenId: tokenIdForContract(tx.networkId, highestReceived.contract),
      value: highestReceived.value.toString(),
    },
    outAmount: {
      tokenId: tokenIdForContract(tx.networkId, highestSold.contract),
      value: highestSold.value.toString(),
    },
    fromTokenAmounts: fromTokenAmounts.length > 1 ? fromTokenAmounts : undefined,
  }
}

function classifyAggregatorSwap(
  tx: ClassifierTx,
  logs: ClassifierLog[],
  userAddress: string,
): SwapTransaction | null {
  // Plan rule 2: detect Transfer(user -> X) + Transfer(X -> user) where X is
  // the same intermediary contract. We don't hardcode the router address; any
  // contract that follows this Transfer pattern is treated as a swap.
  const userLower = userAddress.toLowerCase()
  if (tx.from.toLowerCase() !== userLower) return null

  const transfers = decodeTransferLogs(logs)
  const outbound = transfers.filter((m) => m.from === userLower)
  const inbound = transfers.filter((m) => m.to === userLower)
  if (outbound.length === 0 || inbound.length === 0) return null

  // The aggregator is the address that received tokens from the user AND
  // returned (different) tokens to the user.
  const outboundCounterparties = new Set(outbound.map((m) => m.to))
  const inboundCounterparties = new Set(inbound.map((m) => m.from))
  const intersect = [...outboundCounterparties].filter((a) => inboundCounterparties.has(a))
  if (intersect.length === 0) return null

  const outboundSum = aggregateByToken(outbound)
  const inboundSum = aggregateByToken(inbound)

  // Require the in and out tokens to be different — else this is just a self
  // round-trip and not a swap.
  const outTokens = [...outboundSum.keys()]
  const inTokens = [...inboundSum.keys()]
  if (outTokens.length === 1 && inTokens.length === 1 && outTokens[0] === inTokens[0]) {
    return null
  }

  const highestOut = pickHighest(outboundSum)
  const highestIn = pickHighest(inboundSum)
  if (!highestOut || !highestIn) return null

  return {
    ...baseFields(tx, userAddress),
    type: 'SWAP_TRANSACTION',
    inAmount: {
      tokenId: tokenIdForContract(tx.networkId, highestIn.contract),
      value: highestIn.value.toString(),
    },
    outAmount: {
      tokenId: tokenIdForContract(tx.networkId, highestOut.contract),
      value: highestOut.value.toString(),
    },
  }
}

function classifyApprove(
  tx: ClassifierTx,
  userAddress: string,
): ApprovalTransaction | null {
  if (tx.from.toLowerCase() !== userAddress.toLowerCase()) return null
  if (selectorOf(tx.input) !== SELECTOR_APPROVE) return null
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
    return {
      ...baseFields(tx, userAddress),
      type: 'SENT',
      amount: {
        tokenId: tx.to ? tokenIdForContract(tx.networkId, tx.to) : NATIVE_TOKEN_ID,
        value: decodeUint256(valueWord).toString(),
      },
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
    return {
      ...baseFields(tx, userAddress),
      type: isSent ? 'SENT' : 'RECEIVED',
      amount: {
        tokenId: tx.to ? tokenIdForContract(tx.networkId, tx.to) : NATIVE_TOKEN_ID,
        value: value.toString(),
      },
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
    amount: {
      tokenId: NATIVE_TOKEN_ID,
      value: tx.valueWei.toString(),
    },
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
    amount: {
      tokenId: tokenIdForContract(tx.networkId, top.contract),
      value: top.value.toString(),
    },
    address: firstSender,
  }
}

export function classify(
  tx: ClassifierTx,
  logs: ClassifierLog[],
  userAddress: string,
): TokenTransaction[] {
  if (tx.status !== 'success') return []

  // Rules are applied in plan order; the first matching rule wins.
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
