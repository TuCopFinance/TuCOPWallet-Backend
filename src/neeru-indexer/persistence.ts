import type { Pool, PoolClient } from 'pg'
import { createLogger } from '../lib/logger'
import { CONTRACT_ADDRESS, READ_ABI } from './abi'
import { isNeeruCategory } from './parser'
import type { NeeruIndexerRpcClient } from './rpc'
import type {
  KindAArgs,
  KindBArgs,
  KindCArgs,
  KindDArgs,
  NeeruCategory,
  NeeruEvent,
  NeeruEventWithoutTimestamp,
  NeeruOnchainBatchContext,
} from './types'

const log = createLogger('neeru-indexer:persistence')

// Per-tranche lock seconds are immutable for the lifetime of a contract
// impl, so cache them once across ticks. A tick that contains kind=d
// renewals can read from cache instead of re-fetching tranches(cat).
const lockSecondsCache: Map<NeeruCategory, bigint> = new Map()

export function _resetLockSecondsCacheForTests(): void {
  lockSecondsCache.clear()
}

export async function buildOnchainContext(
  rpc: NeeruIndexerRpcClient,
  events: ReadonlyArray<NeeruEventWithoutTimestamp>,
): Promise<NeeruOnchainBatchContext> {
  const ctx: NeeruOnchainBatchContext = {
    positionCategory: new Map(),
    blockTimestamps: new Map(),
    lockSecondsByCategory: new Map(),
  }

  if (events.length === 0) return ctx

  const dKindNewIds: bigint[] = []
  const uniqueBlockNumbers = new Set<string>()

  for (const ev of events) {
    uniqueBlockNumbers.add(ev.blockNumber.toString())
    if (ev.kind === 'd') {
      dKindNewIds.push(ev.newId)
    }
  }

  if (dKindNewIds.length > 0) {
    type ReadCall = {
      address: `0x${string}`
      abi: typeof READ_ABI
      functionName: 'positions'
      args: readonly [bigint]
    }
    const calls: ReadCall[] = dKindNewIds.map((id) => ({
      address: CONTRACT_ADDRESS,
      abi: READ_ABI,
      functionName: 'positions',
      args: [id] as const,
    }))
    const results = await rpc.multicall({
      contracts: calls as unknown as Parameters<
        NeeruIndexerRpcClient['multicall']
      >[0]['contracts'],
      allowFailure: false,
    })
    let cursor = 0
    for (const id of dKindNewIds) {
      const raw = results[cursor++] as readonly unknown[]
      const cat = Number(raw[1])
      ctx.positionCategory.set(id.toString(), cat)
    }

    const uniqueCats = new Set<NeeruCategory>()
    for (const cat of ctx.positionCategory.values()) {
      if (isNeeruCategory(cat)) uniqueCats.add(cat)
    }

    const cachedCats: NeeruCategory[] = []
    const uncachedCats: NeeruCategory[] = []
    for (const cat of uniqueCats) {
      if (lockSecondsCache.has(cat)) {
        cachedCats.push(cat)
      } else {
        uncachedCats.push(cat)
      }
    }
    for (const cat of cachedCats) {
      ctx.lockSecondsByCategory.set(cat, lockSecondsCache.get(cat)!)
    }

    if (uncachedCats.length > 0) {
      type TrancheCall = {
        address: `0x${string}`
        abi: typeof READ_ABI
        functionName: 'tranches'
        args: readonly [NeeruCategory]
      }
      const trancheCalls: TrancheCall[] = uncachedCats.map((cat) => ({
        address: CONTRACT_ADDRESS,
        abi: READ_ABI,
        functionName: 'tranches',
        args: [cat] as const,
      }))
      const trancheResults = await rpc.multicall({
        contracts: trancheCalls as unknown as Parameters<
          NeeruIndexerRpcClient['multicall']
        >[0]['contracts'],
        allowFailure: false,
      })
      for (let i = 0; i < uncachedCats.length; i++) {
        const cat = uncachedCats[i]!
        const raw = trancheResults[i] as readonly unknown[]
        const lockSecs = BigInt(raw[1] as bigint | number | string)
        lockSecondsCache.set(cat, lockSecs)
        ctx.lockSecondsByCategory.set(cat, lockSecs)
      }
    }
  }

  for (const blockNumberStr of uniqueBlockNumbers) {
    const blockNumber = BigInt(blockNumberStr)
    const block = await rpc.getBlock({ blockNumber })
    ctx.blockTimestamps.set(blockNumberStr, block.timestamp)
  }

  return ctx
}

export function attachTimestamps(
  events: ReadonlyArray<NeeruEventWithoutTimestamp>,
  ctx: NeeruOnchainBatchContext,
): NeeruEvent[] {
  return events.map((ev) => {
    const ts = ctx.blockTimestamps.get(ev.blockNumber.toString())
    if (ts == null) {
      throw new Error(
        `neeru indexer: missing block timestamp for blockNumber=${ev.blockNumber.toString()} txHash=${ev.txHash} logIndex=${ev.logIndex}`,
      )
    }
    return { ...(ev as NeeruEvent), blockTimestamp: ts }
  })
}

async function insertRow(
  client: PoolClient,
  row: {
    id: bigint
    user: string
    category: NeeruCategory
    amount: bigint
    startTs: bigint
    endTs: bigint
    blockNumber: bigint
    txHash: string
  },
  onConflictDoNothing: boolean,
): Promise<void> {
  const conflictClause = onConflictDoNothing
    ? 'ON CONFLICT (position_id) DO NOTHING'
    : ''
  await client.query(
    `INSERT INTO neeru_positions (
       position_id,
       user_address,
       category,
       amount,
       start_ts,
       end_ts,
       deposit_block,
       deposit_tx_hash,
       closed
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
     ${conflictClause}`,
    [
      row.id.toString(),
      row.user,
      row.category,
      row.amount.toString(),
      row.startTs.toString(),
      row.endTs.toString(),
      row.blockNumber.toString(),
      row.txHash,
    ],
  )
}

async function markEnded(
  client: PoolClient,
  id: bigint,
  blockTimestamp: bigint,
  blockNumber: bigint,
  txHash: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE neeru_positions
        SET closed = TRUE,
            closed_at_ts = $2,
            closed_block = $3,
            closed_tx_hash = $4,
            updated_at = NOW()
      WHERE position_id = $1`,
    [
      id.toString(),
      blockTimestamp.toString(),
      blockNumber.toString(),
      txHash,
    ],
  )
  return result.rowCount ?? 0
}

export async function handleKindA(
  client: PoolClient,
  args: KindAArgs,
): Promise<void> {
  await insertRow(
    client,
    {
      id: args.id,
      user: args.user,
      category: args.category,
      amount: args.amount,
      startTs: args.blockTimestamp,
      endTs: args.endTs,
      blockNumber: args.blockNumber,
      txHash: args.txHash,
    },
    true,
  )
  log.debug(
    `event indexed kind=a id=${args.id.toString()} user=${args.user} category=${args.category} amount=${args.amount.toString()} txHash=${args.txHash}`,
  )
}

export async function handleKindB(
  client: PoolClient,
  args: KindBArgs,
): Promise<void> {
  const updated = await markEnded(
    client,
    args.id,
    args.blockTimestamp,
    args.blockNumber,
    args.txHash,
  )
  if (updated === 0) {
    log.warn(
      `kind=b: row not found - indexer out of sync or backfill gap. id=${args.id.toString()} user=${args.user} txHash=${args.txHash}`,
    )
    return
  }
  log.debug(
    `event indexed kind=b id=${args.id.toString()} user=${args.user} txHash=${args.txHash}`,
  )
}

export async function handleKindC(
  client: PoolClient,
  args: KindCArgs,
): Promise<void> {
  const updated = await markEnded(
    client,
    args.id,
    args.blockTimestamp,
    args.blockNumber,
    args.txHash,
  )
  if (updated === 0) {
    log.warn(
      `kind=c: row not found - indexer out of sync or backfill gap. id=${args.id.toString()} user=${args.user} txHash=${args.txHash}`,
    )
    return
  }
  log.debug(
    `event indexed kind=c id=${args.id.toString()} user=${args.user} txHash=${args.txHash}`,
  )
}

export async function handleKindD(
  client: PoolClient,
  args: KindDArgs,
  ctx: NeeruOnchainBatchContext,
): Promise<void> {
  await markEnded(
    client,
    args.oldId,
    args.blockTimestamp,
    args.blockNumber,
    args.txHash,
  )

  const cat = ctx.positionCategory.get(args.newId.toString())
  if (cat == null || !isNeeruCategory(cat)) {
    throw new Error(
      `kind=d: missing or invalid pre-fetched category for newId=${args.newId.toString()} (got ${cat})`,
    )
  }

  // For locked tranches the new row's start is the old row's end (the
  // event carries that end). For non-locked categories or any case where
  // the per-tranche lock window is not available, fall back to the block
  // timestamp so the row still inserts cleanly.
  const lockSecs = ctx.lockSecondsByCategory.get(cat)
  const startTs =
    lockSecs != null && lockSecs > 0n && args.endTs >= lockSecs
      ? args.endTs - lockSecs
      : args.blockTimestamp

  await insertRow(
    client,
    {
      id: args.newId,
      user: args.user,
      category: cat,
      amount: args.newAmount,
      startTs,
      endTs: args.endTs,
      blockNumber: args.blockNumber,
      txHash: args.txHash,
    },
    false,
  )

  log.debug(
    `event indexed kind=d oldId=${args.oldId.toString()} newId=${args.newId.toString()} user=${args.user} newAmount=${args.newAmount.toString()} txHash=${args.txHash}`,
  )
}

export async function dispatchNeeruEvent(
  client: PoolClient,
  event: NeeruEvent,
  ctx: NeeruOnchainBatchContext,
): Promise<void> {
  switch (event.kind) {
    case 'a':
      return handleKindA(client, event)
    case 'b':
      return handleKindB(client, event)
    case 'c':
      return handleKindC(client, event)
    case 'd':
      return handleKindD(client, event, ctx)
  }
}

// Advisory-lock helpers live with the persistence layer because they
// gate every DB write. Pinning a specific 64-bit integer means two
// replicas can race for the lock and the loser becomes a no-op for that
// tick, preventing duplicate RPC spend and double-write races. The number
// is arbitrary but stable; do NOT change it once deployed.
export const NEERU_INDEXER_ADVISORY_LOCK_KEY = 7320041002n

export async function tryAcquireIndexerLock(db: Pool): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS ok',
    [NEERU_INDEXER_ADVISORY_LOCK_KEY.toString()],
  )
  return rows[0]?.ok === true
}

export async function releaseIndexerLock(db: Pool): Promise<void> {
  await db.query('SELECT pg_advisory_unlock($1::bigint)', [
    NEERU_INDEXER_ADVISORY_LOCK_KEY.toString(),
  ])
}
