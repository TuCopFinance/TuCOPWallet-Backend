import type { Pool, PoolClient } from 'pg'
import { createLogger } from '../lib/logger'
import type { TimelockIndexerState } from './types'

const log = createLogger('neeru-timelock:state')

interface TimelockStateRow {
  id: number
  last_scanned_block: string
  last_scan_at: Date
  last_error: string | null
  last_error_at: Date | null
}

function rowToState(row: TimelockStateRow): TimelockIndexerState {
  return {
    id: 1,
    lastScannedBlock: BigInt(row.last_scanned_block),
    lastScanAt: row.last_scan_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  }
}

export async function getTimelockState(
  db: Pool,
): Promise<TimelockIndexerState | null> {
  const { rows } = await db.query<TimelockStateRow>(
    `SELECT id,
            last_scanned_block::text AS last_scanned_block,
            last_scan_at,
            last_error,
            last_error_at
       FROM neeru_timelock_state
      WHERE id = 1`,
  )
  if (rows.length === 0 || !rows[0]) return null
  return rowToState(rows[0])
}

export async function ensureTimelockStateSeed(
  db: Pool,
  seedBlock: bigint,
): Promise<void> {
  await db.query(
    `INSERT INTO neeru_timelock_state (id, last_scanned_block)
     VALUES (1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [seedBlock.toString()],
  )
}

export async function setLastScannedBlock(
  client: PoolClient,
  blockNumber: bigint,
): Promise<void> {
  await client.query(
    `UPDATE neeru_timelock_state
        SET last_scanned_block = $1,
            last_scan_at = NOW()
      WHERE id = 1`,
    [blockNumber.toString()],
  )
}

export async function recordTimelockError(
  db: Pool,
  message: string,
): Promise<void> {
  try {
    await db.query(
      `UPDATE neeru_timelock_state
          SET last_error = $1,
              last_error_at = NOW()
        WHERE id = 1`,
      [message],
    )
  } catch (err) {
    log.warn(
      `recordTimelockError failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
