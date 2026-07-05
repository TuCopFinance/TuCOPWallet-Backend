import type { Pool, PoolClient } from 'pg'
import { createLogger } from '../lib/logger'
import { isEventForContract } from './parser'
import type { TimelockEventWithTimestamp } from './types'

const log = createLogger('neeru-timelock:persistence')

// Same advisory-lock pattern as the neeru-indexer, distinct key so the two
// workers never contend with each other and a stuck Timelock lock does not
// stall the position indexer or vice versa.
export const NEERU_TIMELOCK_ADVISORY_LOCK_KEY = 7320041003n

export async function tryAcquireTimelockLock(db: Pool): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS ok',
    [NEERU_TIMELOCK_ADVISORY_LOCK_KEY.toString()],
  )
  return rows[0]?.ok === true
}

export async function releaseTimelockLock(db: Pool): Promise<void> {
  await db.query('SELECT pg_advisory_unlock($1::bigint)', [
    NEERU_TIMELOCK_ADVISORY_LOCK_KEY.toString(),
  ])
}

export async function insertScheduled(
  client: PoolClient,
  args: {
    operationId: string
    target: string
    value: bigint
    calldata: string
    predecessor: string
    delay: bigint
    blockNumber: bigint
    blockTimestamp: bigint
    txHash: string
    logIndex: number
  },
): Promise<void> {
  const readyTs = args.blockTimestamp + args.delay
  await client.query(
    `INSERT INTO neeru_upgrade_events (
       kind, operation_id, target, value, calldata, predecessor,
       delay, ready_ts,
       block_number, block_timestamp, tx_hash, log_index
     ) VALUES (
       'scheduled', $1, $2, $3, $4, $5,
       $6, $7,
       $8, $9, $10, $11
     )
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      args.operationId,
      args.target,
      args.value.toString(),
      args.calldata,
      args.predecessor,
      args.delay.toString(),
      readyTs.toString(),
      args.blockNumber.toString(),
      args.blockTimestamp.toString(),
      args.txHash,
      args.logIndex,
    ],
  )
}

export async function insertExecuted(
  client: PoolClient,
  args: {
    operationId: string
    target: string
    value: bigint
    calldata: string
    blockNumber: bigint
    blockTimestamp: bigint
    txHash: string
    logIndex: number
  },
): Promise<void> {
  await client.query(
    `INSERT INTO neeru_upgrade_events (
       kind, operation_id, target, value, calldata,
       block_number, block_timestamp, tx_hash, log_index
     ) VALUES (
       'executed', $1, $2, $3, $4,
       $5, $6, $7, $8
     )
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      args.operationId,
      args.target,
      args.value.toString(),
      args.calldata,
      args.blockNumber.toString(),
      args.blockTimestamp.toString(),
      args.txHash,
      args.logIndex,
    ],
  )
}

export async function insertCancelled(
  client: PoolClient,
  args: {
    operationId: string
    blockNumber: bigint
    blockTimestamp: bigint
    txHash: string
    logIndex: number
  },
): Promise<void> {
  await client.query(
    `INSERT INTO neeru_upgrade_events (
       kind, operation_id,
       block_number, block_timestamp, tx_hash, log_index
     ) VALUES (
       'cancelled', $1,
       $2, $3, $4, $5
     )
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      args.operationId,
      args.blockNumber.toString(),
      args.blockTimestamp.toString(),
      args.txHash,
      args.logIndex,
    ],
  )
}

// True iff we already persisted a scheduled row for this operationId (i.e.
// the operation targeted our contract). Used to accept the paired executed /
// cancelled events even though they carry no target field.
async function hasKnownOperation(
  client: PoolClient,
  operationId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM neeru_upgrade_events
        WHERE operation_id = $1 AND kind = 'scheduled'
     ) AS exists`,
    [operationId],
  )
  return rows[0]?.exists === true
}

export async function dispatchTimelockEvent(
  client: PoolClient,
  event: TimelockEventWithTimestamp,
  contractAddress: `0x${string}`,
): Promise<void> {
  const ev = event.event
  const ts = event.blockTimestamp

  switch (ev.kind) {
    case 'scheduled': {
      if (!isEventForContract(ev, contractAddress)) return
      await insertScheduled(client, {
        operationId: ev.operationId,
        target: ev.target,
        value: ev.value,
        calldata: ev.calldata,
        predecessor: ev.predecessor,
        delay: ev.delay,
        blockNumber: ev.blockNumber,
        blockTimestamp: ts,
        txHash: ev.txHash,
        logIndex: ev.logIndex,
      })
      log.warn(
        `UPGRADE SCHEDULED: operationId=${ev.operationId} target=${ev.target} delay=${ev.delay.toString()}s readyTs=${(ts + ev.delay).toString()} txHash=${ev.txHash}`,
      )
      return
    }

    case 'executed': {
      if (!isEventForContract(ev, contractAddress)) {
        // Might still match by operationId if scheduled was recorded and
        // target was fudged; be lax and check the DB.
        const known = await hasKnownOperation(client, ev.operationId)
        if (!known) return
      }
      await insertExecuted(client, {
        operationId: ev.operationId,
        target: ev.target,
        value: ev.value,
        calldata: ev.calldata,
        blockNumber: ev.blockNumber,
        blockTimestamp: ts,
        txHash: ev.txHash,
        logIndex: ev.logIndex,
      })
      log.warn(
        `UPGRADE EXECUTED: operationId=${ev.operationId} target=${ev.target} txHash=${ev.txHash}`,
      )
      return
    }

    case 'cancelled': {
      const known = await hasKnownOperation(client, ev.operationId)
      if (!known) return
      await insertCancelled(client, {
        operationId: ev.operationId,
        blockNumber: ev.blockNumber,
        blockTimestamp: ts,
        txHash: ev.txHash,
        logIndex: ev.logIndex,
      })
      log.warn(
        `UPGRADE CANCELLED: operationId=${ev.operationId} txHash=${ev.txHash}`,
      )
      return
    }
  }
}
