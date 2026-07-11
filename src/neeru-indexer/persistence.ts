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

// Module-scope cache for per-category read values used by handleKindD.
// Reads are stable for the lifetime of the process, so caching avoids a
// redundant multicall per tick.
const secsCache: Map<NeeruCategory, bigint> = new Map()

export function _resetSecsCacheForTests(): void {
  secsCache.clear()
}

export async function buildOnchainContext(
  rpc: NeeruIndexerRpcClient,
  events: ReadonlyArray<NeeruEventWithoutTimestamp>,
): Promise<NeeruOnchainBatchContext> {
  const ctx: NeeruOnchainBatchContext = {
    positionCategory: new Map(),
    blockTimestamps: new Map(),
    secsByCategory: new Map(),
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
      if (secsCache.has(cat)) {
        cachedCats.push(cat)
      } else {
        uncachedCats.push(cat)
      }
    }
    for (const cat of cachedCats) {
      ctx.secsByCategory.set(cat, secsCache.get(cat)!)
    }

    if (uncachedCats.length > 0) {
      type CategoryReadCall = {
        address: `0x${string}`
        abi: typeof READ_ABI
        functionName: 'categories'
        args: readonly [NeeruCategory]
      }
      const catCalls: CategoryReadCall[] = uncachedCats.map((cat) => ({
        address: CONTRACT_ADDRESS,
        abi: READ_ABI,
        functionName: 'categories',
        args: [cat] as const,
      }))
      const catResults = await rpc.multicall({
        contracts: catCalls as unknown as Parameters<
          NeeruIndexerRpcClient['multicall']
        >[0]['contracts'],
        allowFailure: false,
      })
      for (let i = 0; i < uncachedCats.length; i++) {
        const cat = uncachedCats[i]!
        const raw = catResults[i] as readonly unknown[]
        const secs = BigInt(raw[1] as bigint | number | string)
        secsCache.set(cat, secs)
        ctx.secsByCategory.set(cat, secs)
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

  // startTs derived from the per-category cached value when available,
  // block timestamp fallback otherwise so the row always inserts.
  const secs = ctx.secsByCategory.get(cat)
  const startTs =
    secs != null && secs > 0n && args.endTs >= secs
      ? args.endTs - secs
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
