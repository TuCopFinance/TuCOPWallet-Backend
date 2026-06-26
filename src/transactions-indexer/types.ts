// Shared types for the Transaction Feed Indexer (WRI Track C).
//
// The TokenTransaction shape mirrors what the TuCop wallet consumes today
// from Valora's getWalletTransactions, with one extension for EIP-7702
// atomic batches: SwapTransaction may carry `fromTokenAmounts[]` in addition
// to the legacy `outAmount`, so the wallet can render the full set of
// "sold" tokens without losing precision. See
// `tasks/plans/wri-transaction-feed-indexer.md` for the rationale.

export type NetworkId = 'celo-mainnet'

export type TokenTransactionType =
  | 'RECEIVED'
  | 'SENT'
  | 'SWAP_TRANSACTION'
  | 'APPROVAL'

export interface LocalAmount {
  value: string
  currencyCode: string
  exchangeRate: string
}

export interface TokenAmount {
  tokenId: string
  value: string
  localAmount?: LocalAmount | null
}

export interface FeeEntry {
  type: 'SECURITY_FEE'
  amount: TokenAmount
}

interface BaseTransaction {
  networkId: NetworkId
  transactionHash: string
  timestamp: number
  block: string
  address: string
  fees: FeeEntry[]
}

export interface TransferTransaction extends BaseTransaction {
  type: 'RECEIVED' | 'SENT'
  amount: TokenAmount
}

export interface SwapTransaction extends BaseTransaction {
  type: 'SWAP_TRANSACTION'
  inAmount: TokenAmount
  outAmount: TokenAmount
  // 7702 extension: full list of "sold" tokens when the swap was an atomic
  // batch with multiple fromTokens. Optional for back-compat with single-leg
  // swaps. The wallet may render this when present, else fall back to
  // outAmount (which is the highest-value leg).
  fromTokenAmounts?: TokenAmount[]
}

export interface ApprovalTransaction extends BaseTransaction {
  type: 'APPROVAL'
  approvedAddress: string
  tokenId: string
}

export type TokenTransaction =
  | TransferTransaction
  | SwapTransaction
  | ApprovalTransaction

// Raw shapes loaded from Postgres / viem for the classifier.
export interface RawTxRow {
  network_id: string
  tx_hash: string
  block_number: string
  block_timestamp: Date
  tx_index: number
  from_address: string
  to_address: string | null
  value_wei: string
  status: string
  gas_used: string | null
  effective_gas_price: string | null
  fee_currency: string | null
  raw_input: string
}

export interface RawLogRow {
  log_index: number
  contract: string
  topic0: string
  topic1: string | null
  topic2: string | null
  topic3: string | null
  data: string
}

// Minimal tx + logs shape consumed by the classifier (decoupled from the
// pg Row* types so unit tests can build fixtures without touching the DB).
export interface ClassifierTx {
  networkId: NetworkId
  hash: string
  blockNumber: bigint
  blockTimestampMs: number
  txIndex: number
  from: string
  to: string | null
  valueWei: bigint
  status: 'success' | 'reverted'
  gasUsed: bigint | null
  effectiveGasPrice: bigint | null
  feeCurrency: string | null
  input: string
}

export interface ClassifierLog {
  logIndex: number
  contract: string
  topic0: string
  topic1: string | null
  topic2: string | null
  topic3: string | null
  data: string
}
