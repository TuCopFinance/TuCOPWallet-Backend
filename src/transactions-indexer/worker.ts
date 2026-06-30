import type { Pool } from 'pg'
import type { Hash } from 'viem'
import { createCeloPublicClient, getFornoUrl } from '../lib/celoClient'
import { getDb } from '../lib/db'
import { env } from '../lib/env'
import { createLogger } from '../lib/logger'
import {
  transactionsIndexerLagBlocks,
  transactionsIndexerWatchedAddresses,
} from '../lib/metrics'
import { NETWORK_ID, persistTx } from './persist'

const log = createLogger('indexer:worker')

const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ERC20_APPROVAL_TOPIC0 =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
// When first run, start N blocks behind tip. 25 blocks is ~2 minutes on Celo
// (5 s block time) - a small backfill window that catches in-flight txs the
// wallet may already be polling for, without scanning historical state.
const DEFAULT_GENESIS_OFFSET = 25
// After this many consecutive tick failures escalate the log line so operator
// monitoring can page on a stuck indexer vs transient RPC blips.
const ERROR_ESCALATION_THRESHOLD = 5

// Minimal subset of the viem PublicClient we depend on. Defining it as an
// interface lets the worker accept a mocked client in unit tests without
// dragging in the full viem chain plumbing.
export interface IndexerRpcClient {
  getBlockNumber(): Promise<bigint>
  getBlock(args: {
    blockNumber: bigint
    includeTransactions: true
  }): Promise<{
    timestamp: bigint
    transactions: ReadonlyArray<{
      hash: Hash
      from: string
      to: string | null
      transactionIndex: number | null
      value: bigint
      input: string
    }>
  }>
  getTransactionReceipt(args: { hash: Hash }): Promise<{
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
  }>
}

function buildDefaultClient() {
  return createCeloPublicClient({ url: getFornoUrl() })
}

function isWatchedTopic(topic: string | null, watched: Set<string>): boolean {
  if (!topic || topic.length !== 66) return false
  // topic encodes a 32-byte address (left-padded). Drop the leading 24 hex
  // chars (12 bytes of zero padding) and lowercase the trailing 20-byte addr.
  const addr = `0x${topic.slice(26).toLowerCase()}`
  return watched.has(addr)
}

function logTouchesWatched(
  topics: ReadonlyArray<string>,
  watched: Set<string>,
): boolean {
  // For ERC20 Transfer/Approval, topic1 = from/owner and topic2 = to/spender.
  // For other events we still check both slots defensively (cheap).
  const t0 = topics[0]
  if (t0 !== ERC20_TRANSFER_TOPIC0 && t0 !== ERC20_APPROVAL_TOPIC0) return false
  return (
    isWatchedTopic(topics[1] ?? null, watched) ||
    isWatchedTopic(topics[2] ?? null, watched)
  )
}

async function loadWatchedAddresses(db: Pool): Promise<Set<string>> {
  const { rows } = await db.query<{ address: string }>(
    'SELECT address FROM watched_address',
  )
  return new Set(rows.map((r) => r.address.toLowerCase()))
}

async function getLastBlock(db: Pool, currentTip: bigint): Promise<bigint> {
  const { rows } = await db.query<{ last_block: string }>(
    'SELECT last_block FROM indexer_state WHERE network_id = $1',
    [NETWORK_ID],
  )
  if (rows.length === 0 || !rows[0]) {
    // Seed at (tip - genesisOffset). We don't want to scan from block 0.
    const seed = currentTip > BigInt(DEFAULT_GENESIS_OFFSET)
      ? currentTip - BigInt(DEFAULT_GENESIS_OFFSET)
      : 0n
    await db.query(
      `INSERT INTO indexer_state (network_id, last_block)
       VALUES ($1, $2)
       ON CONFLICT (network_id) DO NOTHING`,
      [NETWORK_ID, seed.toString()],
    )
    return seed
  }
  return BigInt(rows[0].last_block)
}

export interface IngestOptions {
  fromBlock: bigint
  toBlock: bigint
  watched: Set<string>
}

export interface IngestResult {
  txCount: number
  logCount: number
}

// Concurrency limit for getTransactionReceipt fan-out. A block with 100 txs
// historically generated 100 sequential RPC calls (~50ms each on Forno warm
// path = 5s per block, 1000s per 200-block tick). Parallelizing with 10
// workers brings tick latency from ~minutes to ~tens of seconds on the same
// hardware. Not a dep on p-limit because the helper below is 10 LOC and
// has no third-party surface to audit.
const DEFAULT_RECEIPT_CONCURRENCY = 10

async function withConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i] as T)
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

export async function ingestRange(
  rpc: IndexerRpcClient,
  db: Pool,
  opts: IngestOptions,
): Promise<IngestResult> {
  let txCount = 0
  let logCount = 0

  for (let bn = opts.fromBlock; bn <= opts.toBlock; bn++) {
    const block = await rpc.getBlock({ blockNumber: bn, includeTransactions: true })
    const blockTimestampMs = Number(block.timestamp) * 1000

    // Pre-fetch all receipts in this block concurrently. Persisting still
    // happens sequentially below so the existing tx-ordering invariants
    // (cursor advance, log ordering) are preserved exactly.
    const receipts = await withConcurrency(
      block.transactions,
      DEFAULT_RECEIPT_CONCURRENCY,
      (tx) => rpc.getTransactionReceipt({ hash: tx.hash }),
    )

    for (let i = 0; i < block.transactions.length; i++) {
      const tx = block.transactions[i]!
      const receipt = receipts[i]!
      const from = tx.from.toLowerCase()
      const to = tx.to ? tx.to.toLowerCase() : null
      const directTouch = opts.watched.has(from) || (to !== null && opts.watched.has(to))
      const logTouch =
        !directTouch &&
        receipt.logs.some((lg) => logTouchesWatched(lg.topics, opts.watched))

      if (!directTouch && !logTouch) continue

      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await persistTx(client, {
          tx,
          blockNumber: bn,
          blockTimestampMs,
          receipt,
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        log.warn(
          `persist failed for tx ${tx.hash}: ${err instanceof Error ? err.message : String(err)}`,
        )
        throw err
      } finally {
        client.release()
      }

      txCount += 1
      logCount += receipt.logs.length
    }
  }

  return { txCount, logCount }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export interface StartIndexerOptions {
  rpcClient?: IndexerRpcClient
  pollIntervalMs?: number
  maxBlocksPerTick?: number
  // Stop the loop when this AbortSignal aborts. server.ts wires SIGTERM ->
  // controller.abort() so a Railway shutdown signal lets the worker finish
  // the current tick instead of being killed mid-INSERT.
  signal?: AbortSignal
  // Max iterations - tests only. Production leaves this undefined to loop
  // forever (until signal aborts).
  iterations?: number
}

// Postgres advisory-lock key for the transactions indexer. Different from the
// Neeru indexer key (7320041002) so the two workers can run concurrently.
// Two replicas race for this lock and the loser becomes a no-op for that
// tick, preventing duplicate getTransactionReceipt RPC spend. Do NOT change
// once deployed.
export const TRANSACTIONS_INDEXER_ADVISORY_LOCK_KEY = 7320041003n

export async function tryAcquireTransactionsIndexerLock(
  db: Pool,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS ok',
    [TRANSACTIONS_INDEXER_ADVISORY_LOCK_KEY.toString()],
  )
  return rows[0]?.ok === true
}

export async function releaseTransactionsIndexerLock(
  db: Pool,
): Promise<void> {
  await db.query('SELECT pg_advisory_unlock($1::bigint)', [
    TRANSACTIONS_INDEXER_ADVISORY_LOCK_KEY.toString(),
  ])
}

export async function startIndexer(
  options: StartIndexerOptions = {},
): Promise<void> {
  const db = getDb()
  if (!db) {
    log.warn('DATABASE_URL not configured; indexer is a no-op')
    return
  }

  const rpc = options.rpcClient ?? (buildDefaultClient() as unknown as IndexerRpcClient)
  const pollIntervalMs =
    options.pollIntervalMs ?? env.INDEXER_POLL_INTERVAL_MS
  const maxBlocksPerTick =
    options.maxBlocksPerTick ?? env.INDEXER_MAX_BLOCKS_PER_TICK
  const signal = options.signal
  const maxIterations = options.iterations

  log.info(
    `starting indexer (pollIntervalMs=${pollIntervalMs} maxBlocksPerTick=${maxBlocksPerTick})`,
  )

  let watched = await loadWatchedAddresses(db)
  let watchedLoadedAt = Date.now()
  let consecutiveErrors = 0
  let count = 0

  // Graceful stop: signal aborted = exit the loop AFTER the current tick.
  // Lock release runs in finally so a SIGTERM mid-tick still frees it for the
  // next replica.
  for (;;) {
    if (signal?.aborted) {
      log.info('shutdown signal received; transactions indexer stopping')
      return
    }
    if (maxIterations != null && count >= maxIterations) return
    count += 1

    try {
      // Multi-replica safety: skip the tick if another replica holds the
      // advisory lock. Acquired-and-released per iteration so a crash
      // between ticks frees it for the next replica.
      const haveLock = await tryAcquireTransactionsIndexerLock(db)
      if (!haveLock) {
        await sleep(pollIntervalMs)
        continue
      }

      try {
        if (Date.now() - watchedLoadedAt > 60_000) {
          watched = await loadWatchedAddresses(db)
          watchedLoadedAt = Date.now()
        }

        const tip = await rpc.getBlockNumber()
        const last = await getLastBlock(db, tip)
        // Refresh observability gauges on every tick whether or not we end up
        // doing work; /metrics scrapes between health route calls read these.
        // Cheap in-process gauge sets, no I/O.
        transactionsIndexerWatchedAddresses
          .labels({ network_id: NETWORK_ID })
          .set(watched.size)
        transactionsIndexerLagBlocks
          .labels({ network_id: NETWORK_ID })
          .set(tip > last ? Number(tip - last) : 0)
        if (tip <= last) {
          consecutiveErrors = 0
          continue
        }

        const cap = last + BigInt(maxBlocksPerTick)
        const target = tip < cap ? tip : cap
        const from = last + 1n

        if (watched.size === 0) {
          // Nothing to ingest; advance the cursor so we don't refetch later.
          await db.query(
            `UPDATE indexer_state SET last_block = $1 WHERE network_id = $2`,
            [target.toString(), NETWORK_ID],
          )
          consecutiveErrors = 0
          continue
        }

        const result = await ingestRange(rpc, db, {
          fromBlock: from,
          toBlock: target,
          watched,
        })

        // Cursor advance is at-least-once on purpose: ingestRange commits each
        // matched tx in its own BEGIN/COMMIT transaction, then we bump the
        // cursor here after the range completes. A crash between the per-tx
        // commits and this cursor UPDATE means the next tick will re-fetch
        // and re-attempt persist for those txs. persistTx uses ON CONFLICT
        // (network_id, tx_hash) DO NOTHING so the re-attempt is a safe no-op.
        // Cost: wasted RPC + DB churn on crash recovery. Benefit: simpler
        // code, zero risk of "missed tx", batched cursor write per-tick
        // instead of per-tx.
        await db.query(
          `UPDATE indexer_state SET last_block = $1 WHERE network_id = $2`,
          [target.toString(), NETWORK_ID],
        )

        if (result.txCount > 0) {
          log.info(
            `tick complete: blocks=${from}..${target} txs=${result.txCount} logs=${result.logCount}`,
          )
        }
        consecutiveErrors = 0
      } finally {
        await releaseTransactionsIndexerLock(db).catch((err) => {
          log.warn(
            `advisory unlock failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }

      await sleep(pollIntervalMs)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      consecutiveErrors += 1
      if (consecutiveErrors >= ERROR_ESCALATION_THRESHOLD) {
        log.error(`tick failed (${consecutiveErrors} consecutive): ${message}`)
      } else {
        log.warn(`tick failed: ${message}`)
      }
      await sleep(pollIntervalMs)
    }
  }
}
