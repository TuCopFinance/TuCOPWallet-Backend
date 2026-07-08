import type { Pool, PoolClient } from 'pg'
import type { Hash } from 'viem'
import {
  createCeloFallbackExecutor,
  type FallbackExecutor,
} from '../lib/celoRpcFallback'
import { env } from '../lib/env'
import { createLogger } from '../lib/logger'
import {
  transactionsIndexerBackfillActiveJobs,
  transactionsIndexerBackfillBlocksRemaining,
  transactionsIndexerBackfillChunksTotal,
} from '../lib/metrics'
import { persistTx } from './persist'

// Robust historical backfill for the transactions indexer.
//
// Design (2026-07-06 rewrite - see JOURNAL for the rationale):
//
//   1. RPC fallback chain via `createCeloFallbackExecutor`. Circuit breaker
//      per endpoint (3 fails -> skip 5 min), rotation on any transient
//      error. Backfill never dies because Forno rate limited us; it
//      transparently switches to Ankr / dRPC.
//   2. Per-chunk progress checkpoint. `watched_address.backfill_cursor_block`
//      is advanced inside the same transaction that inserts the chunk's tx
//      rows. Container crash / restart / redeploy resumes from that block,
//      not from tip - depth.
//   3. Interleaved persist. Each chunk: get logs -> fetch tx+receipt+block
//      per hash -> single BEGIN/COMMIT with all inserts + cursor update.
//      No two-phase all-or-nothing.
//   4. Adaptive backoff. Baseline delay between chunks is
//      env.TX_INDEXER_BACKFILL_CHUNK_DELAY_MS; on RPC failure it doubles up
//      to MAX_DELAY_MS and decays back down on success. Combines with the
//      fallback executor's circuit breaker.
//   5. Boot-time resume. `resumePendingBackfills(db)` is called from
//      server.ts and re-launches every row where backfill_completed_at IS
//      NULL AND backfill_cursor_block IS NOT NULL. Multi-hour backfills
//      survive normal Railway redeploys.
//   6. Prometheus metrics. Chunks-processed counter labeled by outcome,
//      active-jobs gauge, blocks-remaining gauge for Grafana ETA charts.
//
// Deferred (follow-up if we ever run > 20 concurrent backfills or scale to
// multi-instance): a proper `backfill_job` queue table + advisory lock for
// multi-instance safety + round-robin scheduler across addresses to
// enforce a global RPC budget. For a single Railway replica with tens of
// wallets, the per-address loop is enough.

const log = createLogger('indexer:backfill')

const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// Celo public RPCs cap eth_getLogs at 5000 blocks per request. Confirmed in
// #19 when the first live deploy failed silently behind the 3-RPC fallback.
const LOG_BATCH_BLOCKS = 5_000

// In-process dedupe: a second /watch hit for the same address while a
// backfill loop is running should not spawn a second concurrent loop.
// Cleared automatically when the loop exits (success or error).
const inProgress = new Set<string>()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function paddedAddressTopic(address: string): string {
  return '0x' + '0'.repeat(24) + address.slice(2).toLowerCase()
}

interface RawLog {
  transactionHash: string
  blockNumber: bigint
}

interface RawTx {
  hash: `0x${string}`
  from: string
  to: string | null
  transactionIndex: number | null
  value: bigint
  input: string
  blockNumber?: bigint
  feeCurrency?: string | null
}

interface RawReceipt {
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

interface FetchedTx {
  tx: RawTx
  receipt: RawReceipt
  blockNumber: bigint
  blockTimestampMs: number
}

// ---------------------------------------------------------------------------
// RPC helpers (all go through the fallback executor)
// ---------------------------------------------------------------------------

async function rpcGetLogs(
  executor: FallbackExecutor,
  label: string,
  fromBlock: bigint,
  toBlock: bigint,
  topics: ReadonlyArray<string | null>,
): Promise<RawLog[]> {
  const result = (await executor.withFallback(label, async (client) => {
    return await client.request({
      method: 'eth_getLogs',
      params: [
        {
          topics: topics as `0x${string}`[],
          fromBlock: `0x${fromBlock.toString(16)}` as `0x${string}`,
          toBlock: `0x${toBlock.toString(16)}` as `0x${string}`,
        },
      ],
    })
  })) as Array<{ transactionHash: string; blockNumber: string | null }>
  return result.map((r) => ({
    transactionHash: r.transactionHash,
    blockNumber: r.blockNumber ? BigInt(r.blockNumber) : 0n,
  }))
}

async function rpcGetBlockNumber(executor: FallbackExecutor): Promise<bigint> {
  return executor.withFallback('getBlockNumber', (c) => c.getBlockNumber())
}

async function rpcFetchTx(
  executor: FallbackExecutor,
  hash: string,
): Promise<FetchedTx | null> {
  const [tx, receipt] = (await Promise.all([
    executor.withFallback(`getTransaction ${hash}`, (c) =>
      c.getTransaction({ hash: hash as Hash }),
    ),
    executor.withFallback(`getTransactionReceipt ${hash}`, (c) =>
      c.getTransactionReceipt({ hash: hash as Hash }),
    ),
  ])) as [RawTx & { blockNumber?: bigint }, RawReceipt]
  const blockNumber = tx.blockNumber ?? null
  if (blockNumber === null) return null
  const block = (await executor.withFallback(`getBlock ${blockNumber}`, (c) =>
    c.getBlock({ blockNumber }),
  )) as { timestamp: bigint }
  return {
    tx,
    receipt,
    blockNumber,
    blockTimestampMs: Number(block.timestamp) * 1000,
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface BackfillWindow {
  cursorBlock: bigint | null
  endBlock: bigint | null
  initialFromBlock: bigint | null
  completedAt: Date | null
}

async function readBackfillWindow(
  db: Pool,
  address: string,
): Promise<BackfillWindow | null> {
  const { rows } = await db.query<{
    backfill_cursor_block: string | null
    backfill_end_block: string | null
    backfill_initial_from_block: string | null
    backfill_completed_at: Date | null
  }>(
    `SELECT backfill_cursor_block::text AS backfill_cursor_block,
            backfill_end_block::text AS backfill_end_block,
            backfill_initial_from_block::text AS backfill_initial_from_block,
            backfill_completed_at
       FROM watched_address WHERE address = $1`,
    [address],
  )
  if (rows.length === 0 || !rows[0]) return null
  const row = rows[0]
  return {
    cursorBlock: row.backfill_cursor_block ? BigInt(row.backfill_cursor_block) : null,
    endBlock: row.backfill_end_block ? BigInt(row.backfill_end_block) : null,
    initialFromBlock: row.backfill_initial_from_block
      ? BigInt(row.backfill_initial_from_block)
      : null,
    completedAt: row.backfill_completed_at,
  }
}

async function initializeBackfillWindowIfNeeded(
  db: Pool,
  address: string,
  currentTip: bigint,
  depthBlocks: bigint,
  walletCreatedAtIso: string | undefined,
): Promise<{ cursor: bigint; end: bigint } | null> {
  const existing = await readBackfillWindow(db, address)
  if (!existing) return null
  if (existing.completedAt) return null
  if (existing.cursorBlock != null && existing.endBlock != null) {
    return { cursor: existing.cursorBlock, end: existing.endBlock }
  }
  const end = currentTip
  const defaultFrom = currentTip > depthBlocks ? currentTip - depthBlocks : 0n
  let from = defaultFrom
  if (walletCreatedAtIso) {
    const derived = walletCreatedAtToFromBlock(walletCreatedAtIso, currentTip)
    // Extend only: never truncate a valid default window if the user
    // creation date happens to be more recent than the default depth.
    if (derived < from) from = derived
  }
  await db.query(
    `UPDATE watched_address
       SET backfill_cursor_block = $1,
           backfill_end_block = $2,
           backfill_initial_from_block = $1
     WHERE address = $3`,
    [from.toString(), end.toString(), address],
  )
  log.info(
    `backfill window initialized for ${address}: [${from.toString()}, ${end.toString()}]${walletCreatedAtIso ? ` (walletCreatedAt=${walletCreatedAtIso})` : ''}`,
  )
  return { cursor: from, end }
}

// Re-open a completed backfill when a new /watch call carries a
// `walletCreatedAt` that implies a fromBlock DEEPER than what we
// already scanned. One-shot per row: after the re-opened window
// finishes, `backfill_initial_from_block` records the new floor and
// subsequent /watch calls with the same or shallower walletCreatedAt
// no-op.
//
// Scanned range on re-open:
//   [walletCreatedAt-derived new_from, existing initial_from - 1]
//
// For legacy rows (backfilled pre-2026-07-07, `initial_from_block` IS
// NULL), we do not know the original scanned floor, so we conservatively
// re-scan up to `backfill_end_block` (the tip when the original
// backfill snapped). persistTx is upsert-idempotent so overlap is safe;
// it costs a bounded amount of redundant RPC work per legacy row, once.
//
// Returns true when the row was re-opened (backfill loop should be
// triggered), false when the row already covers the requested
// walletCreatedAt (no-op).
export async function reopenBackfillIfDeeper(
  db: Pool,
  address: string,
  currentTip: bigint,
  walletCreatedAtIso: string,
): Promise<boolean> {
  const window = await readBackfillWindow(db, address)
  if (!window) return false
  if (!window.completedAt) return false
  if (window.endBlock == null) return false
  const derivedFrom = walletCreatedAtToFromBlock(walletCreatedAtIso, currentTip)
  // If the row already recorded an initial_from and the new derived
  // fromBlock is not deeper, nothing to do.
  if (window.initialFromBlock != null && derivedFrom >= window.initialFromBlock) {
    return false
  }
  // New end for the re-opened window: the boundary between what we
  // already scanned and the new deeper range. For legacy rows without
  // a recorded initial_from we accept the redundant re-scan up to
  // the previous end block.
  const newEnd =
    window.initialFromBlock != null && window.initialFromBlock > 0n
      ? window.initialFromBlock - 1n
      : window.endBlock
  if (derivedFrom > newEnd) {
    // walletCreatedAt implies a range above what we would scan (edge
    // case, e.g. very-recent walletCreatedAt on an older-tip
    // backfill). Nothing to re-open.
    return false
  }
  await db.query(
    `UPDATE watched_address
       SET backfill_completed_at = NULL,
           backfill_cursor_block = $1,
           backfill_end_block = $2,
           backfill_initial_from_block = $1,
           backfill_last_error = NULL
     WHERE address = $3`,
    [derivedFrom.toString(), newEnd.toString(), address],
  )
  log.info(
    `backfill re-opened for ${address}: [${derivedFrom.toString()}, ${newEnd.toString()}] (walletCreatedAt=${walletCreatedAtIso})`,
  )
  return true
}

async function markBackfillCompleted(db: Pool, address: string): Promise<void> {
  await db.query(
    `UPDATE watched_address SET backfill_completed_at = now() WHERE address = $1`,
    [address],
  )
}

async function persistChunkAtomically(
  db: Pool,
  address: string,
  fetched: FetchedTx[],
  newCursor: bigint,
): Promise<{ persisted: number; persistErrors: number }> {
  let persisted = 0
  let persistErrors = 0
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const item of fetched) {
      try {
        await persistTx(client, {
          tx: {
            hash: item.tx.hash,
            from: item.tx.from,
            to: item.tx.to,
            transactionIndex: item.tx.transactionIndex,
            value: item.tx.value,
            input: item.tx.input,
            feeCurrency: item.tx.feeCurrency ?? null,
          },
          blockNumber: item.blockNumber,
          blockTimestampMs: item.blockTimestampMs,
          receipt: item.receipt,
        })
        persisted += 1
      } catch (err) {
        persistErrors += 1
        log.warn(
          `persistTx failed for ${item.tx.hash} in chunk of ${address}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    await (client as PoolClient).query(
      `UPDATE watched_address SET backfill_cursor_block = $1 WHERE address = $2`,
      [newCursor.toString(), address],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { persisted, persistErrors }
}

async function recordChunkError(
  db: Pool,
  address: string,
  message: string,
): Promise<void> {
  await db
    .query(
      `UPDATE watched_address
         SET backfill_last_error = $1,
             backfill_last_attempt_at = now()
       WHERE address = $2`,
      [message.slice(0, 500), address],
    )
    .catch((err) => {
      log.warn(
        `failed to record chunk error for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function refreshBlocksRemainingGauge(db: Pool): Promise<void> {
  try {
    const { rows } = await db.query<{ remaining: string | null }>(
      `SELECT COALESCE(SUM(backfill_end_block - backfill_cursor_block), 0)::text AS remaining
         FROM watched_address
        WHERE backfill_completed_at IS NULL
          AND backfill_cursor_block IS NOT NULL
          AND backfill_end_block IS NOT NULL`,
    )
    const raw = rows[0]?.remaining ?? '0'
    transactionsIndexerBackfillBlocksRemaining.set(Number(BigInt(raw)))
  } catch {
    // not fatal; gauge stays stale, live worker gauges are independent.
  }
}

export interface RunBackfillOptions {
  executor?: FallbackExecutor
  depthBlocksOverride?: number
  chunkDelayMsOverride?: number
  maxDelayMsOverride?: number
  // When set, the backfill window's `fromBlock` is chosen as the older of
  // (a) the tip-minus-depth default and (b) an estimate derived from
  // walletCreatedAtIso via `walletCreatedAtToFromBlock`. Cap enforced
  // internally via SAFETY_MAX_BACKFILL_BLOCKS.
  walletCreatedAtIso?: string
}

// Celo L2 migration (block 31056500, ~2025-03-26). Pre-migration blocks
// average ~5 s each; post-migration ~1 s. We segment the conversion so a
// wallet created before the migration doesn't get an underestimated
// fromBlock (which would leave old activity outside the scan window).
const CELO_L2_MIGRATION_TIMESTAMP_MS = Date.parse('2025-03-26T00:00:00Z')
const POST_L2_SECS_PER_BLOCK = 1
const PRE_L2_SECS_PER_BLOCK = 5

// Never scan more than this many blocks even if walletCreatedAt implies a
// deeper window. Protects the relay from an accidentally-huge backfill
// blowing up the RPC budget for other watched wallets. 5M blocks is about
// 8 weeks post-L2 which covers 99%+ of TuCop user creation dates today.
const SAFETY_MAX_BACKFILL_BLOCKS = 5_000_000n

// Absolute safety cushion added to the derived from-block. Real Celo L2
// block time averages ~1.04 s/block, not the flat 1 s the formula assumes;
// over 14 days that under-estimates the block delta by ~4-8k blocks and
// leaves the very first txs of the wallet outside the scan window. Fixed
// by shifting the derived fromBlock BACKWARD by this many blocks. Also
// covers the case where a wallet was pre-funded a few blocks before the
// user-set creation timestamp. Observed 2026-07-08 with spike v2
// (walletCreatedAt=2026-06-24, actual first tx block ~7k blocks deeper
// than the formula's estimate).
const WALLET_CREATED_AT_SAFETY_BUFFER_BLOCKS = 50_000n

export function walletCreatedAtToFromBlock(
  walletCreatedAtIso: string,
  currentTip: bigint,
  nowMs: number = Date.now(),
): bigint {
  const createdAtMs = Date.parse(walletCreatedAtIso)
  if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs) return currentTip
  const secondsSinceCreation = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000))
  let approxBlocks: bigint
  if (createdAtMs >= CELO_L2_MIGRATION_TIMESTAMP_MS) {
    approxBlocks = BigInt(secondsSinceCreation * POST_L2_SECS_PER_BLOCK)
  } else {
    const postL2Seconds = Math.max(0, Math.floor((nowMs - CELO_L2_MIGRATION_TIMESTAMP_MS) / 1000))
    const preL2Seconds = Math.max(
      0,
      Math.floor((CELO_L2_MIGRATION_TIMESTAMP_MS - createdAtMs) / 1000),
    )
    approxBlocks =
      BigInt(postL2Seconds * POST_L2_SECS_PER_BLOCK) +
      BigInt(Math.floor(preL2Seconds / PRE_L2_SECS_PER_BLOCK))
  }
  // Add safety buffer BEFORE the cap so the cap remains the hard ceiling
  // (a caller cannot escape the 5M limit by chaining the buffer).
  approxBlocks += WALLET_CREATED_AT_SAFETY_BUFFER_BLOCKS
  if (approxBlocks > SAFETY_MAX_BACKFILL_BLOCKS) {
    approxBlocks = SAFETY_MAX_BACKFILL_BLOCKS
  }
  return currentTip > approxBlocks ? currentTip - approxBlocks : 0n
}

// Runs the backfill loop for a single address until either (a) the cursor
// reaches the end block (backfill_completed_at is set), or (b) the process
// stops. Does NOT throw for RPC failures; those are absorbed via the
// fallback executor + adaptive backoff. Only throws for programmer errors
// (missing DB row, etc.) and only after cleanup.
export async function runBackfillLoopForAddress(
  db: Pool,
  address: string,
  options: RunBackfillOptions = {},
): Promise<void> {
  const userLower = address.toLowerCase()
  const executor = options.executor ?? createCeloFallbackExecutor()
  const baselineDelay = options.chunkDelayMsOverride ?? env.TX_INDEXER_BACKFILL_CHUNK_DELAY_MS
  const maxDelay = options.maxDelayMsOverride ?? env.TX_INDEXER_BACKFILL_MAX_DELAY_MS
  const depth = BigInt(options.depthBlocksOverride ?? env.TX_INDEXER_BACKFILL_BLOCKS)

  // Initialize window if this is the first attempt for the address.
  let tip: bigint
  try {
    tip = await rpcGetBlockNumber(executor)
  } catch (err) {
    log.error(
      `failed to get tip for initial backfill of ${userLower}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  const window = await initializeBackfillWindowIfNeeded(
    db,
    userLower,
    tip,
    depth,
    options.walletCreatedAtIso,
  )
  if (!window) {
    log.info(`no active backfill needed for ${userLower} (row missing or completed)`)
    return
  }

  transactionsIndexerBackfillActiveJobs.inc()
  try {
    const topicAddress = paddedAddressTopic(userLower)
    let currentDelay = baselineDelay

    for (;;) {
      // Re-read progress each iteration in case some other actor (a manual
      // reset SQL, a concurrent /watch, etc.) mutated the row.
      const state = await readBackfillWindow(db, userLower)
      if (!state || state.cursorBlock == null || state.endBlock == null) {
        log.warn(`backfill state missing mid-loop for ${userLower}; stopping`)
        return
      }
      if (state.completedAt) return
      let cursor = state.cursorBlock
      const end = state.endBlock
      if (cursor > end) {
        await markBackfillCompleted(db, userLower)
        log.info(`backfill complete for ${userLower} (cursor > end)`)
        return
      }

      const chunkStart = cursor
      const chunkEnd =
        chunkStart + BigInt(LOG_BATCH_BLOCKS) - 1n > end
          ? end
          : chunkStart + BigInt(LOG_BATCH_BLOCKS) - 1n

      try {
        // 1) Scan logs (2 concurrent slots per chunk).
        const [outboundLogs, inboundLogs] = await Promise.all([
          rpcGetLogs(
            executor,
            `getLogs outbound ${chunkStart}-${chunkEnd}`,
            chunkStart,
            chunkEnd,
            [ERC20_TRANSFER_TOPIC0, topicAddress, null],
          ),
          rpcGetLogs(
            executor,
            `getLogs inbound ${chunkStart}-${chunkEnd}`,
            chunkStart,
            chunkEnd,
            [ERC20_TRANSFER_TOPIC0, null, topicAddress],
          ),
        ])

        // 2) Fetch tx + receipt + block per unique hash.
        const seen = new Set<string>()
        for (const l of [...outboundLogs, ...inboundLogs]) {
          seen.add(l.transactionHash.toLowerCase())
        }
        const fetched: FetchedTx[] = []
        for (const hash of seen) {
          try {
            const item = await rpcFetchTx(executor, hash)
            if (item) fetched.push(item)
          } catch (err) {
            log.warn(
              `rpc fetch failed for ${hash}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }

        // 3) Single transaction: persist all tx + advance cursor. All-or-nothing
        //    at the CHUNK level (individual tx persist errors are logged but
        //    the successful ones still land + cursor still advances).
        const newCursor = chunkEnd + 1n
        const { persistErrors } = await persistChunkAtomically(db, userLower, fetched, newCursor)

        if (persistErrors > 0) {
          transactionsIndexerBackfillChunksTotal.labels({ outcome: 'persist_error' }).inc()
        } else {
          transactionsIndexerBackfillChunksTotal.labels({ outcome: 'ok' }).inc()
        }

        cursor = newCursor
        // Decay delay on success; never below baseline.
        currentDelay = Math.max(baselineDelay, Math.floor(currentDelay * 0.8))
      } catch (err) {
        // Every fallback endpoint failed for a call in this chunk. Do NOT
        // advance the cursor; back off + retry next iteration.
        transactionsIndexerBackfillChunksTotal.labels({ outcome: 'rpc_error' }).inc()
        const message = err instanceof Error ? err.message : String(err)
        currentDelay = Math.min(maxDelay, currentDelay === 0 ? baselineDelay : currentDelay * 2)
        await recordChunkError(db, userLower, message)
        log.warn(
          `chunk [${chunkStart.toString()}, ${chunkEnd.toString()}] failed for ${userLower}; backoff to ${currentDelay}ms: ${message}`,
        )
      }

      await refreshBlocksRemainingGauge(db)
      await sleep(currentDelay)
    }
  } finally {
    transactionsIndexerBackfillActiveJobs.dec()
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Fire-and-forget wrapper called from POST /api/transactions/watch. Dedupes
// concurrent triggers via inProgress. Never throws.
export function triggerBackfill(
  db: Pool,
  address: string,
  options: RunBackfillOptions = {},
): void {
  if (!env.TX_INDEXER_BACKFILL_ENABLED) {
    log.info(`backfill disabled by env; skipping trigger for ${address}`)
    return
  }
  const userLower = address.toLowerCase()
  if (inProgress.has(userLower)) return
  inProgress.add(userLower)
  void (async () => {
    try {
      await runBackfillLoopForAddress(db, userLower, options)
    } catch (err) {
      log.error(
        `backfill loop crashed for ${userLower}: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      inProgress.delete(userLower)
    }
  })()
}

// Boot-time resume. Called from server.ts after startIndexer(). Picks up
// every row where backfill_completed_at IS NULL AND backfill_cursor_block IS
// NOT NULL and re-launches the loop. Guards against redeploys / restarts
// killing multi-hour backfills.
export async function resumePendingBackfills(
  db: Pool,
  options: RunBackfillOptions = {},
): Promise<number> {
  if (!env.TX_INDEXER_BACKFILL_ENABLED) {
    log.info('backfill disabled by env; skipping resume sweep at boot')
    return 0
  }
  const { rows } = await db.query<{ address: string }>(
    `SELECT address FROM watched_address
      WHERE backfill_completed_at IS NULL
        AND backfill_cursor_block IS NOT NULL
        AND backfill_end_block IS NOT NULL`,
  )
  let started = 0
  for (const r of rows) {
    if (inProgress.has(r.address)) continue
    triggerBackfill(db, r.address, options)
    started += 1
  }
  if (started > 0) {
    log.info(`resumed ${started} pending backfill jobs at boot`)
  }
  return started
}

export const _testHelpers = {
  isInProgress(address: string): boolean {
    return inProgress.has(address.toLowerCase())
  },
  clearInProgress(): void {
    inProgress.clear()
  },
}
