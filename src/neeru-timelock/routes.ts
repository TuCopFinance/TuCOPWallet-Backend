// GET /api/earn/neeru/upgrade-schedule
//
// Read-only surface for dashboards + Neeru's monitoring: returns the most
// recent scheduled operations targeting the tracked contract, grouped by
// state (pending / executed / cancelled), along with the indexer state so
// operators can tell "silence = no upgrades" from "silence = indexer stuck".

import { Router, type Request, type Response } from 'express'
import type { Pool } from 'pg'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { getTimelockState } from './state'

const log = createLogger('neeru-timelock:routes')

interface UpgradeEventRow {
  event_id: string
  kind: 'scheduled' | 'executed' | 'cancelled'
  operation_id: string
  target: string | null
  value: string | null
  calldata: string | null
  predecessor: string | null
  delay: string | null
  ready_ts: string | null
  block_number: string
  block_timestamp: string
  tx_hash: string
  log_index: number
  created_at: Date
}

interface UpgradeOperation {
  operationId: string
  scheduled: {
    target: string
    value: string
    calldata: string
    predecessor: string
    delay: string
    readyTs: string
    blockNumber: string
    blockTimestamp: string
    txHash: string
    logIndex: number
  }
  executed?: {
    blockNumber: string
    blockTimestamp: string
    txHash: string
    logIndex: number
  }
  cancelled?: {
    blockNumber: string
    blockTimestamp: string
    txHash: string
    logIndex: number
  }
  status: 'pending' | 'executed' | 'cancelled'
}

async function loadOperations(db: Pool): Promise<UpgradeOperation[]> {
  const { rows } = await db.query<UpgradeEventRow>(
    `SELECT event_id::text AS event_id,
            kind,
            operation_id,
            target,
            value::text AS value,
            calldata,
            predecessor,
            delay::text AS delay,
            ready_ts::text AS ready_ts,
            block_number::text AS block_number,
            block_timestamp::text AS block_timestamp,
            tx_hash,
            log_index,
            created_at
       FROM neeru_upgrade_events
      ORDER BY block_number ASC, log_index ASC`,
  )

  const byOp = new Map<string, UpgradeOperation>()

  for (const row of rows) {
    if (row.kind === 'scheduled') {
      byOp.set(row.operation_id, {
        operationId: row.operation_id,
        scheduled: {
          target: row.target ?? '',
          value: row.value ?? '0',
          calldata: row.calldata ?? '0x',
          predecessor: row.predecessor ?? '',
          delay: row.delay ?? '0',
          readyTs: row.ready_ts ?? '0',
          blockNumber: row.block_number,
          blockTimestamp: row.block_timestamp,
          txHash: row.tx_hash,
          logIndex: row.log_index,
        },
        status: 'pending',
      })
    } else if (row.kind === 'executed') {
      const op = byOp.get(row.operation_id)
      if (!op) continue
      op.executed = {
        blockNumber: row.block_number,
        blockTimestamp: row.block_timestamp,
        txHash: row.tx_hash,
        logIndex: row.log_index,
      }
      op.status = 'executed'
    } else if (row.kind === 'cancelled') {
      const op = byOp.get(row.operation_id)
      if (!op) continue
      op.cancelled = {
        blockNumber: row.block_number,
        blockTimestamp: row.block_timestamp,
        txHash: row.tx_hash,
        logIndex: row.log_index,
      }
      op.status = 'cancelled'
    }
  }

  return Array.from(byOp.values())
}

export const neeruTimelockRouter = Router()

neeruTimelockRouter.get(
  '/api/earn/neeru/upgrade-schedule',
  async (_req: Request, res: Response) => {
    const db = getDb()
    if (!db) {
      return res.status(503).json({ error: 'database not configured' })
    }

    try {
      const [state, operations] = await Promise.all([
        getTimelockState(db),
        loadOperations(db),
      ])

      const pending = operations.filter((op) => op.status === 'pending')
      const executed = operations.filter((op) => op.status === 'executed')
      const cancelled = operations.filter((op) => op.status === 'cancelled')

      return res.json({
        data: {
          pending,
          executed,
          cancelled,
          lastSyncedBlock: state ? state.lastScannedBlock.toString() : null,
          lastSyncedAt: state ? state.lastScanAt.toISOString() : null,
          lastError: state?.lastError ?? null,
          lastErrorAt: state?.lastErrorAt?.toISOString() ?? null,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`upgrade-schedule failed: ${message}`)
      return res.status(500).json({ error: 'internal error' })
    }
  },
)
