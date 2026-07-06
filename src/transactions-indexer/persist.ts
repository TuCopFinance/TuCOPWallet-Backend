import type { PoolClient } from 'pg'
import type { Hash } from 'viem'

// Shared persistence helpers for the transactions indexer.
// Both the live worker (forward-only ingestion) and the backfill job
// (historical fill on first watch) write through these so the row shape and
// idempotency guarantees stay identical.

export const NETWORK_ID = 'celo-mainnet'

export interface PersistTxInput {
  tx: {
    hash: Hash
    from: string
    to: string | null
    transactionIndex: number | null
    value: bigint
    input: string
    // CIP-64 fee currency address (may be a Mento stable directly OR an
    // adapter contract like the USDC / USDT ones). Persisted verbatim; the
    // classifier does the adapter -> underlying translation on emit.
    feeCurrency?: string | null
  }
  blockNumber: bigint
  blockTimestampMs: number
  receipt: {
    status: 'success' | 'reverted'
    transactionIndex: number
    gasUsed: bigint
    effectiveGasPrice: bigint | undefined
    logs: ReadonlyArray<{
      logIndex: number | null
      address: string
      topics: ReadonlyArray<string>
      data: string
    }>
  }
}

export function inferTxType(
  input: string,
  valueWei: bigint,
  to: string | null,
): string {
  if (!to) return 'CONTRACT_CREATE'
  if (input === '0x' || input === '') return valueWei > 0n ? 'NATIVE_SEND' : 'NATIVE_NOOP'
  return 'CONTRACT_CALL'
}

export async function persistTx(
  client: PoolClient,
  p: PersistTxInput,
): Promise<void> {
  const txIndex = p.tx.transactionIndex ?? p.receipt.transactionIndex
  const insertTx = await client.query<{ id: string }>(
    `INSERT INTO tx (
       network_id, tx_hash, block_number, block_timestamp, tx_index,
       from_address, to_address, value_wei, tx_type, status,
       gas_used, effective_gas_price, fee_currency, raw_input
     )
     VALUES ($1,$2,$3, to_timestamp($4), $5, $6,$7,$8,$9,$10, $11,$12,$13,$14)
     ON CONFLICT (network_id, tx_hash) DO NOTHING
     RETURNING id`,
    [
      NETWORK_ID,
      p.tx.hash.toLowerCase(),
      p.blockNumber.toString(),
      Math.floor(p.blockTimestampMs / 1000),
      txIndex,
      p.tx.from.toLowerCase(),
      p.tx.to ? p.tx.to.toLowerCase() : null,
      p.tx.value.toString(),
      inferTxType(p.tx.input, p.tx.value, p.tx.to),
      p.receipt.status,
      p.receipt.gasUsed.toString(),
      p.receipt.effectiveGasPrice ? p.receipt.effectiveGasPrice.toString() : null,
      // fee_currency: for CIP-64 txs viem's Celo formatter fills tx.feeCurrency
      // with the fee-token / adapter address; for native-CELO-fee txs it's
      // undefined or the zero address. Normalise both to null so buildFee
      // falls back to the CELO tokenId without an extra check.
      p.tx.feeCurrency && p.tx.feeCurrency !== '0x0000000000000000000000000000000000000000'
        ? p.tx.feeCurrency.toLowerCase()
        : null,
      p.tx.input,
    ],
  )

  let txId: string | null = insertTx.rows[0]?.id ?? null
  if (!txId) {
    // already-inserted by a previous tick; load id so we can ensure logs exist.
    const sel = await client.query<{ id: string }>(
      'SELECT id FROM tx WHERE network_id = $1 AND tx_hash = $2',
      [NETWORK_ID, p.tx.hash.toLowerCase()],
    )
    txId = sel.rows[0]?.id ?? null
    if (!txId) return
  }

  for (const lg of p.receipt.logs) {
    if (lg.logIndex == null) continue
    await client.query(
      `INSERT INTO tx_log (tx_id, log_index, contract, topic0, topic1, topic2, topic3, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tx_id, log_index) DO NOTHING`,
      [
        txId,
        lg.logIndex,
        lg.address.toLowerCase(),
        lg.topics[0]?.toLowerCase() ?? '',
        lg.topics[1] ? lg.topics[1].toLowerCase() : null,
        lg.topics[2] ? lg.topics[2].toLowerCase() : null,
        lg.topics[3] ? lg.topics[3].toLowerCase() : null,
        lg.data,
      ],
    )
  }
}
