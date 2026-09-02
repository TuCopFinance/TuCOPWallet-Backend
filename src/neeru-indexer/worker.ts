import type { Pool } from 'pg'
import { getDb } from '../lib/db'
import { env } from '../lib/env'
import { providerNameFromUrl } from '../lib/celoRpcFallback'
import { createLogger } from '../lib/logger'
import { neeruIndexerLagBlocks } from '../lib/metrics'
import { Sentry } from '../lib/sentry'
import {
  assertIndexerConfig,
  CONTRACT_ADDRESS,
  EVENT_TOPIC0S,
  INDEXER_GENESIS_BLOCK,
} from './abi'
import { parseNeeruLog } from './parser'
import {
  attachTimestamps,
  buildOnchainContext,
  dispatchNeeruEvent,
  releaseIndexerLock,
  tryAcquireIndexerLock,
} from './persistence'
import { runReorgReconciliation } from './reorgJob'
import {
  createNeeruRpc,
  type NeeruIndexerRpcClient,
} from './rpc'
import {
  ensureIndexerStateSeed,
  getIndexerState,
  recordIndexerError,
  setLastScannedBlock,
} from './state'

// Re-exports kept for test files and external callers that already import
// these symbols from './worker'. The implementations now live in the
// parser/persistence modules; the worker is the supervisor loop.
export { parseNeeruLog } from './parser'
export {
  attachTimestamps,
  buildOnchainContext,
  dispatchNeeruEvent,
  handleKindA,
  handleKindB,
  handleKindC,
  handleKindD,
  NEERU_INDEXER_ADVISORY_LOCK_KEY,
  releaseIndexerLock,
  tryAcquireIndexerLock,
} from './persistence'

const log = createLogger('neeru-indexer:worker')

const DEFAULT_REORG_CHECK_INTERVAL_MS = 60_000
const REORG_BUFFER_BLOCKS = 5n
const REORG_RUN_UTC_HOUR = 3
// After this many consecutive tick failures, escalate the log line from warn
// to error so operator monitoring (Sentry/log-based alerts) can page on the
// difference between transient RPC blips and a permanently stuck indexer.
const ERROR_ESCALATION_THRESHOLD = 5

// Classify an RPC error message into a stable tag value. Mirrors the
// classifier in src/transactions-indexer/worker.ts. Kept duplicated
// (5-line file, no shared helper) to avoid coupling the two workers on
// a bump to the classifier surface.
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

// Collapse any URL surfaced by the error message down to a provider
// bucket. Never surface the raw URL: for endpoints like Alchemy the
// path segment carries the API key. Also keeps Sentry tag cardinality
// bounded (one value per known provider + 'other').
function extractRpcEndpoint(msg: string): string | null {
  const m = msg.match(/https:\/\/[a-z0-9.-]+(?:\/[^\s"|)]*)?/i)
  return m ? providerNameFromUrl(m[0]) : null
}

function parseIntervalMs(): number {
  // env.NEERU_INDEXER_INTERVAL_MS is validated + defaulted by the zod schema
  // (zPositiveInt default 30_000). Boot fails fast on invalid values, so we
  // trust the parsed value directly here.
  return env.NEERU_INDEXER_INTERVAL_MS
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export interface TickOptions {
  db: Pool
  rpc: NeeruIndexerRpcClient
}

export function chunkBlockRange(
  from: bigint,
  to: bigint,
  batchSize: bigint = env.NEERU_INDEXER_MAX_BLOCKS_PER_BATCH,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (from > to) return []
  const out: Array<{ fromBlock: bigint; toBlock: bigint }> = []
  let cursor = from
  while (cursor <= to) {
    const end = cursor + batchSize - 1n
    const batchEnd = end < to ? end : to
    out.push({ fromBlock: cursor, toBlock: batchEnd })
    cursor = batchEnd + 1n
  }
  return out
}

export async function runTick(opts: TickOptions): Promise<{
  scanned: boolean
  fromBlock?: bigint
  toBlock?: bigint
  logCount?: number
}> {
  const state = await getIndexerState(opts.db)
  if (!state) {
    throw new Error(
      'neeru_indexer_state row missing - migration not applied or row deleted',
    )
  }

  const latest = await opts.rpc.getBlockNumber()
  if (latest <= REORG_BUFFER_BLOCKS) {
    return { scanned: false }
  }

  // Sanity guard against a silently-degraded RPC provider (2026-07-31
  // incident: rpc.celocolombia.org returned HTTP 200 with `block=0` for
  // eth_blockNumber while the indexer had lastScannedBlock=~50M; the
  // fallback executor did not distinguish "success with bad data" from a
  // real success, so the indexer looked healthy while doing nothing for
  // 3 days). The fallback chain has since been reordered (forno-first),
  // but this guard covers any future recurrence at ANY provider without
  // relying on ordering. Throwing here trips the consecutive-errors
  // counter + the neeru_indexer_stuck Sentry event on threshold cross;
  // recovery is automatic when the next tick sees a sane tip.
  if (latest <= state.lastScannedBlock) {
    throw new Error(
      `rpc_stale_tip: getBlockNumber()=${latest} <= lastScannedBlock=${state.lastScannedBlock}; likely stale RPC provider`,
    )
  }

  // Emit the lag gauge on every tick where we got a sane tip. Uses the raw
  // distance to `latest` (not `safeTip`) so operators see the actual gap,
  // including the intentional REORG_BUFFER_BLOCKS trailing window. Grafana
  // alert when this stays above threshold for >2 min catches silent stalls
  // that the consecutive-error counter would miss (e.g. RPC returns a
  // frozen-but-non-stale tip).
  neeruIndexerLagBlocks.set(Number(latest - state.lastScannedBlock))

  const safeTip = latest - REORG_BUFFER_BLOCKS
  const fromBlock = state.lastScannedBlock + 1n
  if (fromBlock > safeTip) {
    return { scanned: false }
  }

  const batches = chunkBlockRange(fromBlock, safeTip)
  let totalLogs = 0

  for (const batch of batches) {
    const logs = await opts.rpc.getLogs({
      address: CONTRACT_ADDRESS as `0x${string}`,
      topics: [EVENT_TOPIC0S as unknown as `0x${string}`[]],
      fromBlock: batch.fromBlock,
      toBlock: batch.toBlock,
    })
    totalLogs += logs.length

    const parsedWithoutTs = logs.map(parseNeeruLog)
    const ctx = await buildOnchainContext(opts.rpc, parsedWithoutTs)
    const parsed = attachTimestamps(parsedWithoutTs, ctx)

    const client = await opts.db.connect()
    try {
      await client.query('BEGIN')
      for (const event of parsed) {
        await dispatchNeeruEvent(client, event, ctx)
      }
      await setLastScannedBlock(client, batch.toBlock)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  return {
    scanned: true,
    fromBlock,
    toBlock: safeTip,
    logCount: totalLogs,
  }
}

export interface StartNeeruIndexerOptions {
  db?: Pool
  rpc?: NeeruIndexerRpcClient
  intervalMs?: number
  iterations?: number
  enableReorgJob?: boolean
  // Override the default error-backoff sleep between failing ticks (env
  // var NEERU_INDEXER_ERROR_BACKOFF_MS, default 5min). Used by tests so an
  // iterations:N run doesn't actually sleep 5min between every failure.
  errorBackoffMs?: number
  // When aborted the loop breaks at the next iteration boundary + after
  // any in-flight sleep, so Railway SIGTERM does not leave a batch
  // half-committed. See src/server.ts wiring.
  signal?: AbortSignal
}

interface ReorgJobState {
  lastRunDateUtc: string | null
}

function todayUtcDateString(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function scheduleReorgJob(
  rpc: NeeruIndexerRpcClient,
  db: Pool,
  options: {
    intervalMs?: number
    nowFn?: () => Date
  } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? DEFAULT_REORG_CHECK_INTERVAL_MS
  const nowFn = options.nowFn ?? (() => new Date())
  const state: ReorgJobState = { lastRunDateUtc: null }

  const handle = setInterval(() => {
    const now = nowFn()
    if (now.getUTCHours() !== REORG_RUN_UTC_HOUR) return
    if (now.getUTCMinutes() >= 1) return
    const today = todayUtcDateString(now)
    if (state.lastRunDateUtc === today) return
    state.lastRunDateUtc = today
    runReorgReconciliation({ db, rpc }).catch((err) => {
      log.warn(
        `reorg reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }, intervalMs)

  return {
    stop: () => clearInterval(handle),
  }
}

export async function startNeeruIndexer(
  options: StartNeeruIndexerOptions = {},
): Promise<void> {
  const db = options.db ?? getDb()
  if (!db) {
    log.warn('DATABASE_URL not configured; neeru indexer is a no-op')
    return
  }

  assertIndexerConfig()
  await ensureIndexerStateSeed(db, INDEXER_GENESIS_BLOCK - 1n)

  const rpc = options.rpc ?? createNeeruRpc()
  const intervalMs = options.intervalMs ?? parseIntervalMs()
  const maxIterations = options.iterations
  const enableReorgJob = options.enableReorgJob ?? true
  const errorBackoffMs =
    options.errorBackoffMs ?? env.NEERU_INDEXER_ERROR_BACKOFF_MS
  const signal = options.signal

  log.info(`starting neeru indexer (intervalMs=${intervalMs})`)

  let reorgJob: { stop: () => void } | null = null
  if (enableReorgJob) {
    reorgJob = scheduleReorgJob(rpc, db)
    log.info(
      `reconciliation scheduled (daily at ${REORG_RUN_UTC_HOUR}:00 UTC)`,
    )
  }

  let count = 0
  let consecutiveErrors = 0
  let stuckSinceMs: number | null = null
  let lastTickFromBlock: bigint | null = null
  let lastTickToBlock: bigint | null = null
  try {
    for (;;) {
      if (signal?.aborted) return
      if (maxIterations != null && count >= maxIterations) return
      count += 1

      try {
        // Multi-replica safety: skip the tick if another replica holds the
        // advisory lock. Acquired-and-released per iteration so a crash
        // between ticks frees it for the next replica.
        const haveLock = await tryAcquireIndexerLock(db)
        if (!haveLock) {
          await sleep(intervalMs)
          if (signal?.aborted) return
          continue
        }
        try {
          const result = await runTick({ db, rpc })
          if (result.scanned) {
            lastTickFromBlock = result.fromBlock ?? lastTickFromBlock
            lastTickToBlock = result.toBlock ?? lastTickToBlock
            log.info(
              `tick complete: blocks=${result.fromBlock}..${result.toBlock} logs=${result.logCount}`,
            )
          }
        } finally {
          await releaseIndexerLock(db).catch((err) => {
            log.warn(
              `advisory unlock failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          })
        }
        consecutiveErrors = 0
        stuckSinceMs = null
        await sleep(intervalMs)
        if (signal?.aborted) return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        consecutiveErrors += 1
        if (consecutiveErrors === 1) stuckSinceMs = Date.now()
        if (consecutiveErrors === ERROR_ESCALATION_THRESHOLD) {
          // First cross of the threshold - fire ONE Sentry event so alerts
          // ring exactly once per stuck-window instead of per tick after
          // the threshold. Subsequent ticks in the same window keep
          // logging error but do not re-capture; recovery resets
          // consecutiveErrors to 0 and primes the next crossing.
          //
          // Tags carry filterable dimensions (errorClass, rpcEndpoint,
          // contract address). Extras carry the actionable snapshot
          // (last-known scanned range, how long we've been stuck).
          // Together enough to diagnose from Sentry alone.
          Sentry.captureMessage('neeru_indexer_stuck', {
            level: 'error',
            tags: {
              event: 'neeru_indexer_stuck',
              indexer: 'neeru',
              contractAddress: CONTRACT_ADDRESS,
              errorClass: classifyRpcError(message),
              rpcEndpoint: extractRpcEndpoint(message) ?? 'unknown',
            },
            extra: {
              consecutiveErrors,
              stuckSinceMs:
                stuckSinceMs != null ? Date.now() - stuckSinceMs : null,
              lastTickFromBlock: lastTickFromBlock?.toString() ?? null,
              lastTickToBlock: lastTickToBlock?.toString() ?? null,
              lastError: message,
            },
          })
        }
        if (consecutiveErrors >= ERROR_ESCALATION_THRESHOLD) {
          log.error(
            `tick failed (${consecutiveErrors} consecutive): ${message}`,
          )
        } else {
          log.warn(`tick failed: ${message}`)
        }
        await recordIndexerError(db, message)
        await sleep(errorBackoffMs)
        if (signal?.aborted) return
      }
    }
  } finally {
    reorgJob?.stop()
  }
}
