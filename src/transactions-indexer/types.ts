// Shared types for the Transaction Feed Indexer (WRI Track C).
//
// The TokenTransaction shape mirrors what the TuCop wallet consumes today
// from Valora's getWalletTransactions, with one extension for EIP-7702
// atomic batches: SwapTransaction may carry `fromTokenAmounts[]` in addition
// to the legacy `outAmount`, so the wallet can render the full set of
// "sold" tokens without losing precision.

export type NetworkId = 'celo-mainnet'

export type TokenTransactionType =
  | 'RECEIVED'
  | 'SENT'
  | 'SWAP_TRANSACTION'
  | 'APPROVAL'
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'CLAIM_REWARD'

export interface LocalAmount {
  value: string
  currencyCode: string
  exchangeRate: string
}

export interface TokenAmount {
  tokenId: string
  // Human-decimal string (e.g. "3500.000000000000000000"). NOT raw wei -
  // Valora consumers `new BigNumber(value)` and pass it to formatValueToDisplay
  // without dividing by 10^decimals. See `decimalizeValueForClassifier` in
  // ./priceOracle.ts. Emergency fix 2026-07-05: pre-fix the classifier
  // emitted raw wei here and the wallet rendered garbage.
  value: string
  // The number of decimals used to scale `value`. `null` when the token is
  // outside the canonical CIP-64/Mento registry; in that case `value` is
  // the raw wei string as a fallback so no precision is silently lost.
  decimals: number | null
  // Redundant with the parent tx's top-level timestamp, mirrored on each
  // amount to match Valora. Populated by `enrichTransactionWithLocalAmount`
  // so the classifier itself stays timestamp-agnostic per-amount.
  timestamp?: number
  localAmount?: LocalAmount | null
}

export interface FeeEntry {
  type: 'SECURITY_FEE'
  amount: TokenAmount
}

// Terminal status of the tx. Matches the exact strings Valora emits on
// `getWalletTransactions`; the wallet keys off this to decide badge colour /
// error label. Reverted txs used to be omitted entirely; from 2026-07-05
// they surface with `status: "Failed"`.
export type TxTerminalStatus = 'Complete' | 'Failed'

interface BaseTransaction {
  networkId: NetworkId
  transactionHash: string
  timestamp: number
  block: string
  address: string
  status: TxTerminalStatus
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

// User-held Earn positions (Neeru, Allbridge, ...). Shape aligns with the
// Valora feed the wallet timeline already renders in production (v1.118.5
// on Play/App Store as of 2026-07-06):
//
//   - `appName` is the human-readable protocol label ("Neeru Vaults",
//     "Allbridge"). The wallet renderer reads this directly; missing it
//     falls back to the i18n "noTxAppName" placeholder.
//   - `inAmount` / `outAmount` mirror the Valora convention: DEPOSIT reads
//     `outAmount` (money leaving the user), WITHDRAW / CLAIM_REWARD read
//     `inAmount` (money coming in). We populate BOTH with the same
//     TokenAmount so any future renderer branch does not accidentally hit
//     `undefined` and yield `NaN` in the display. Cheap, and keeps the
//     shape robust across wallet versions.
//
// The `appId`, `positionId`, and `amount` fields are TuCop extensions kept
// as extras: the current Valora renderer ignores unknown fields, but the
// wallet team plans to deep-link to `positionId` in a future release so
// the data ships now instead of later.
export interface EarnTransaction extends BaseTransaction {
  type: 'DEPOSIT' | 'WITHDRAW' | 'CLAIM_REWARD'
  appName: string
  inAmount: TokenAmount
  outAmount: TokenAmount
  appId: string
  positionId: string | null
  amount: TokenAmount
}

export type TokenTransaction =
  | TransferTransaction
  | SwapTransaction
  | ApprovalTransaction
  | EarnTransaction

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
