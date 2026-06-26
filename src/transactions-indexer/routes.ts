import { Router, Request, Response } from 'express'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { classify } from './classifier'
import type {
  ClassifierLog,
  ClassifierTx,
  NetworkId,
  RawLogRow,
  RawTxRow,
  TokenTransaction,
} from './types'

const router = Router()
const log = createLogger('routes:transactions')

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const DEFAULT_NETWORK_ID: NetworkId = 'celo-mainnet'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

interface CursorPosition {
  blockNumber: string
  txIndex: number
}

function encodeCursor(pos: CursorPosition): string {
  return Buffer.from(JSON.stringify(pos), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): CursorPosition | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as Partial<CursorPosition>
    if (typeof parsed.blockNumber !== 'string') return null
    if (typeof parsed.txIndex !== 'number') return null
    return { blockNumber: parsed.blockNumber, txIndex: parsed.txIndex }
  } catch {
    return null
  }
}

function parseIncludeTypes(raw: unknown): Set<string> | null {
  if (raw === undefined || raw === '') return null
  if (typeof raw !== 'string') return null
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (list.length === 0) return null
  return new Set(list)
}

function rowToClassifierTx(row: RawTxRow): ClassifierTx {
  return {
    networkId: row.network_id as NetworkId,
    hash: row.tx_hash,
    blockNumber: BigInt(row.block_number),
    blockTimestampMs: row.block_timestamp.getTime(),
    txIndex: row.tx_index,
    from: row.from_address,
    to: row.to_address,
    valueWei: BigInt(row.value_wei),
    status: row.status === 'success' ? 'success' : 'reverted',
    gasUsed: row.gas_used ? BigInt(row.gas_used) : null,
    effectiveGasPrice: row.effective_gas_price ? BigInt(row.effective_gas_price) : null,
    feeCurrency: row.fee_currency,
    input: row.raw_input,
  }
}

function rowToClassifierLog(row: RawLogRow): ClassifierLog {
  return {
    logIndex: row.log_index,
    contract: row.contract,
    topic0: row.topic0,
    topic1: row.topic1,
    topic2: row.topic2,
    topic3: row.topic3,
    data: row.data,
  }
}

router.post('/api/transactions/watch', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { address?: unknown }
  if (typeof body.address !== 'string' || !ADDRESS_RE.test(body.address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = body.address.toLowerCase()

  const db = getDb()
  if (!db) {
    return res.status(503).json({ error: 'database not configured' })
  }

  try {
    await db.query(
      `INSERT INTO watched_address (address) VALUES ($1)
       ON CONFLICT (address) DO NOTHING`,
      [address],
    )
  } catch (err) {
    log.error('watch insert failed:', err instanceof Error ? err.message : err)
    return res.status(500).json({ error: 'database error' })
  }

  // Task 5 (backfill) will populate backfillStartedAt asynchronously; for now
  // we return null so the client knows backfill is not yet in progress.
  return res.json({ ok: true, backfillStartedAt: null })
})

router.get('/api/transactions/feed', async (req: Request, res: Response) => {
  const addressRaw = typeof req.query.address === 'string' ? req.query.address : ''
  if (!ADDRESS_RE.test(addressRaw)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = addressRaw.toLowerCase()

  const networkIdsRaw =
    typeof req.query.networkIds === 'string' ? req.query.networkIds : DEFAULT_NETWORK_ID
  const networkIds = networkIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (networkIds.length === 0) networkIds.push(DEFAULT_NETWORK_ID)

  const includeTypes = parseIncludeTypes(req.query.includeTypes)
  const afterCursorRaw =
    typeof req.query.afterCursor === 'string' && req.query.afterCursor.length > 0
      ? req.query.afterCursor
      : null
  const afterCursor = afterCursorRaw ? decodeCursor(afterCursorRaw) : null
  if (afterCursorRaw && !afterCursor) {
    return res.status(400).json({ error: 'invalid afterCursor' })
  }

  const pageSizeRaw =
    typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : DEFAULT_PAGE_SIZE
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(Math.floor(pageSizeRaw), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE

  const db = getDb()
  if (!db) {
    return res.status(503).json({ error: 'database not configured' })
  }

  // Pull one extra row so we can tell whether there's a next page.
  const limit = pageSize + 1

  const params: unknown[] = [networkIds, address]
  let where = `t.network_id = ANY($1::text[])
       AND (t.from_address = $2 OR t.to_address = $2
            OR EXISTS (
              SELECT 1 FROM tx_log lg
              WHERE lg.tx_id = t.id
                AND (lg.topic1 = $3 OR lg.topic2 = $3)
            ))`
  // topic-encoded address (left-padded to 32 bytes).
  params.push('0x' + '0'.repeat(24) + address.slice(2))

  if (afterCursor) {
    params.push(afterCursor.blockNumber, afterCursor.txIndex)
    where += ` AND (t.block_number, t.tx_index) < ($${params.length - 1}::bigint, $${params.length}::int)`
  }
  params.push(limit)

  let rows: RawTxRow[]
  try {
    const result = await db.query<RawTxRow>(
      `SELECT t.network_id, t.tx_hash, t.block_number::text AS block_number,
              t.block_timestamp, t.tx_index, t.from_address, t.to_address,
              t.value_wei::text AS value_wei, t.status, t.gas_used::text AS gas_used,
              t.effective_gas_price::text AS effective_gas_price, t.fee_currency,
              t.raw_input
         FROM tx t
         WHERE ${where}
         ORDER BY t.block_number DESC, t.tx_index DESC
         LIMIT $${params.length}`,
      params,
    )
    rows = result.rows
  } catch (err) {
    log.error('feed query failed:', err instanceof Error ? err.message : err)
    return res.status(500).json({ error: 'database error' })
  }

  const transactions: TokenTransaction[] = []
  for (const row of rows.slice(0, pageSize)) {
    const cached = await tryReadCache(db, row.network_id, row.tx_hash, address)
    let classified: TokenTransaction[]
    if (cached) {
      classified = cached
    } else {
      const { rows: logRows } = await db.query<RawLogRow>(
        `SELECT log_index, contract, topic0, topic1, topic2, topic3, data
           FROM tx_log lg
           JOIN tx t ON t.id = lg.tx_id
          WHERE t.network_id = $1 AND t.tx_hash = $2
          ORDER BY log_index ASC`,
        [row.network_id, row.tx_hash],
      )
      classified = classify(
        rowToClassifierTx(row),
        logRows.map(rowToClassifierLog),
        address,
      )
      await writeCache(db, row.network_id, row.tx_hash, address, classified)
    }

    for (const t of classified) {
      if (includeTypes && !includeTypes.has(t.type)) continue
      transactions.push(t)
    }
  }

  const hasNextPage = rows.length > pageSize
  const endCursor =
    transactions.length > 0
      ? (() => {
          const lastRow = rows[Math.min(pageSize, rows.length) - 1]
          if (!lastRow) return null
          return encodeCursor({ blockNumber: lastRow.block_number, txIndex: lastRow.tx_index })
        })()
      : null

  return res.json({
    transactions,
    pageInfo: { hasNextPage, endCursor },
  })
})

async function tryReadCache(
  db: NonNullable<ReturnType<typeof getDb>>,
  networkId: string,
  txHash: string,
  userAddress: string,
): Promise<TokenTransaction[] | null> {
  try {
    const { rows } = await db.query<{ payload_json: TokenTransaction[] }>(
      `SELECT payload_json FROM classified_tx_cache
        WHERE network_id = $1 AND tx_hash = $2 AND user_address = $3`,
      [networkId, txHash, userAddress],
    )
    if (rows.length === 0) return null
    const payload = rows[0]?.payload_json
    return Array.isArray(payload) ? payload : null
  } catch (err) {
    log.warn('cache read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

async function writeCache(
  db: NonNullable<ReturnType<typeof getDb>>,
  networkId: string,
  txHash: string,
  userAddress: string,
  payload: TokenTransaction[],
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO classified_tx_cache (network_id, tx_hash, user_address, payload_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (network_id, tx_hash, user_address) DO NOTHING`,
      [networkId, txHash, userAddress, JSON.stringify(payload)],
    )
  } catch (err) {
    log.warn('cache write failed:', err instanceof Error ? err.message : err)
  }
}

export default router
