import type { Pool } from 'pg'
import type { Hash } from 'viem'
import { getSharedCeloFallbackExecutor } from '../lib/celoRpcFallback'
import { getDb } from '../lib/db'
import { env } from '../lib/env'
import { createLogger } from '../lib/logger'
import {
  transactionsIndexerLagBlocks,
  transactionsIndexerWatchedAddresses,
} from '../lib/metrics'
import { Sentry } from '../lib/sentry'
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

// Classify an RPC error message into a stable tag value. Keeps Sentry
// grouping meaningful when the raw error string varies (different tx
// hashes, endpoints, trace-ids). Ordered most-specific first.
function classifyRpcError(msg: string): string {
  if (/rate limit|Too Many Requests|call rate limit exhausted|429/i.test(msg)) {
    return 'rate_limit'
  }
  if (/could not be found/i.test(msg)) return 'receipt_not_found'
  if (/Temporary internal error/i.test(msg)) return 'upstream_internal'
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return 'timeout'
  if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(msg)) return 'network'
  if (/eth_getLogs.*10 block range/i.test(msg)) return 'alchemy_getlogs_cap'
  return 'other'
}

function extractRpcEndpoint(msg: string): string | null {
  const m = msg.match(/https:\/\/[a-z0-9.-]+(?:\/[^\s"|)]*)?/i)
  return m ? m[0] : null
}

// Best-effort extraction of the tx hash embedded in a fallback executor
// error message. Format is typically "getTransactionReceipt <0xhash>" or
// the request body echoed back. Returns null when no hash is found.
function extractTxHashInFlight(msg: string): string | null {
  const m = msg.match(/0x[a-fA-F0-9]{64}/)
  return m ? m[0] : null
}

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
      // Populated by viem's Celo chain formatter for CIP-64 txs (type 0x7b);
      // undefined / '0x' for native-CELO-fee txs. Persisted so the classifier
      // can emit the correct fees[].amount.tokenId (adapter -> underlying
      // mapping happens at classify time).
      feeCurrency?: string | null
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

// Wraps the shared Celo fallback executor into the minimal IndexerRpcClient
// interface the tick loop consumes. Previously this returned a single
// forno-only client with no fallback; a receipt that forno legitimately
// returned as null (e.g. state pruning window, receipt not indexed there
// yet) would throw and the ENTIRE tick would fail. Since the cursor does
// not advance on failure, the next tick re-ran the same block, hit the
// same null-receipt, and looped indefinitely. Confirmed 2026-08-08 on
// tx 0x17acd57569b869320a8ac698292a794f7156f801eae16520419c29ee25582e7d:
// forno returned null, ankr + drpc both returned a valid status:0x1
// receipt. Wrapping the executor here rotates through the fallback chain
// on the FIRST throw so the receipt is fetched from a healthy endpoint,
// the tick completes, and the cursor advances.
function buildDefaultClient(): IndexerRpcClient {
  const executor = getSharedCeloFallbackExecutor()
  return {
    getBlockNumber() {
      return executor.withFallback('indexer:getBlockNumber', (c) =>
        c.getBlockNumber(),
      )
    },
    getBlock(args) {
      return executor.withFallback('indexer:getBlock', (c) =>
        c.getBlock({
          blockNumber: args.blockNumber,
          includeTransactions: true,
        }),
      ) as ReturnType<IndexerRpcClient['getBlock']>
    },
    getTransactionReceipt(args) {
      return executor.withFallback('indexer:getTransactionReceipt', (c) =>
        c.getTransactionReceipt({ hash: args.hash }),
      ) as ReturnType<IndexerRpcClient['getTransactionReceipt']>
    },
  }
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
// path = 5s per block, 1000s per 200-block tick). Parallelizing with a few
// workers brings tick latency from ~minutes to ~tens of seconds on the same
// hardware. Not a dep on p-limit because the helper below is 10 LOC and
// has no third-party surface to audit. Kept at 3 (not 10) to stay under the
// per-second rate limit of the cheapest RPC in the fallback chain (ANKR
// free tier). At 10 concurrent + INDEXER_MAX_BLOCKS_PER_TICK=25 + ~20 tx
// per block, one tick can burst 500 concurrent RPC calls and trip ANKR
// into a 5-min skip window that cascades to alchemy/forno also getting
// saturated, stalling the indexer indefinitely (observed 2026-08-05 to
// 2026-08-15 -> 927k block stall).
const DEFAULT_RECEIPT_CONCURRENCY = 3

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
    //
    // "Receipt not found on all endpoints" is a soft-skip (returns null)
    // instead of throwing the whole tick to a stop. DRPC has been observed
    // 2026-08-15 to drop getTransactionReceipt for real confirmed txs
    // ("Transaction receipt with hash X could not be found"), which
    // propagates through the fallback executor as "all endpoints failed"
    // and stalls the indexer at that tick. Skipping the tx (and logging)
    // preserves forward progress; the address that owned the tx will lose
    // that one row in the feed but the next tick advances the cursor past
    // the problematic block.
    const receipts = await withConcurrency(
      block.transactions,
      DEFAULT_RECEIPT_CONCURRENCY,
      async (tx) => {
        try {
          return await rpc.getTransactionReceipt({ hash: tx.hash })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('could not be found')) {
            log.warn(
              `receipt not found across all endpoints for tx ${tx.hash} in block ${bn.toString()}; skipping (feed will miss this row)`,
            )
            return null
          }
          throw err
        }
      },
    )

    for (let i = 0; i < block.transactions.length; i++) {
      const tx = block.transactions[i]!
      const receipt = receipts[i]
      if (receipt == null) continue
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
  let stuckSinceMs: number | null = null
  // Last known cursor + tip snapshot from the most recent successful tick
  // (or attempted-but-failed tick). Hoisted out of the try block so the
  // catch handler can include them in the Sentry event without needing to
  // re-fetch (which would also fail if RPC is dead).
  let lastAttemptFromBlock: bigint | null = null
  let lastAttemptToBlock: bigint | null = null
  let lastKnownCursor: bigint | null = null
  let lastKnownTip: bigint | null = null
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
        lastKnownCursor = last
        lastKnownTip = tip
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
        lastAttemptFromBlock = from
        lastAttemptToBlock = target

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
        stuckSinceMs = null
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
      if (consecutiveErrors === 1) stuckSinceMs = Date.now()
      if (consecutiveErrors === ERROR_ESCALATION_THRESHOLD) {
        // First cross of the threshold - fire ONE Sentry event so alerts
        // ring exactly once per stuck-window instead of per tick after the
        // threshold. Subsequent ticks in the same window keep logging error
        // but do not re-capture; recovery resets consecutiveErrors to 0 and
        // primes the next crossing. Bursts of 100+ consecutive fails
        // (observed 2026-08-09) now surface immediately.
        //
        // Tags carry the filterable / grouping dimensions (errorClass,
        // rpcEndpoint, network). Extras carry the actionable snapshot
        // (cursor + tip + attempted range + tx hash in-flight + how long
        // we've been stuck). Together these are enough to diagnose from
        // Sentry alone without needing to correlate against Railway logs.
        Sentry.captureMessage('tx_indexer_stuck', {
          level: 'error',
          tags: {
            event: 'tx_indexer_stuck',
            indexer: 'transactions',
            network: NETWORK_ID,
            errorClass: classifyRpcError(message),
            rpcEndpoint: extractRpcEndpoint(message) ?? 'unknown',
          },
          extra: {
            consecutiveErrors,
            stuckSinceMs:
              stuckSinceMs != null ? Date.now() - stuckSinceMs : null,
            lastIndexedBlock: lastKnownCursor?.toString() ?? null,
            celoTipBlock: lastKnownTip?.toString() ?? null,
            lagBlocks:
              lastKnownTip != null && lastKnownCursor != null
                ? Number(lastKnownTip - lastKnownCursor)
                : null,
            attemptedFromBlock: lastAttemptFromBlock?.toString() ?? null,
            attemptedToBlock: lastAttemptToBlock?.toString() ?? null,
            txHashInFlight: extractTxHashInFlight(message),
            lastError: message,
          },
        })
      }
      if (consecutiveErrors >= ERROR_ESCALATION_THRESHOLD) {
        log.error(`tick failed (${consecutiveErrors} consecutive): ${message}`)
      } else {
        log.warn(`tick failed: ${message}`)
      }
      await sleep(pollIntervalMs)
    }
  }
}
