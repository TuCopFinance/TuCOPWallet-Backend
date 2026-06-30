import type { Pool } from 'pg'
import { getDb } from '../lib/db'
import { env } from '../lib/env'
import { createLogger } from '../lib/logger'
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

const DEFAULT_TICK_INTERVAL_MS = 30_000
const DEFAULT_REORG_CHECK_INTERVAL_MS = 60_000
const REORG_BUFFER_BLOCKS = 5n
const REORG_RUN_UTC_HOUR = 3
// After this many consecutive tick failures, escalate the log line from warn
// to error so operator monitoring (Sentry/log-based alerts) can page on the
// difference between transient RPC blips and a permanently stuck indexer.
const ERROR_ESCALATION_THRESHOLD = 5

function parseIntervalMs(): number {
  const raw = process.env.NEERU_INDEXER_INTERVAL_MS
  if (!raw) return DEFAULT_TICK_INTERVAL_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(
      `NEERU_INDEXER_INTERVAL_MS ignored (got: ${raw}); using default ${DEFAULT_TICK_INTERVAL_MS}`,
    )
    return DEFAULT_TICK_INTERVAL_MS
  }
  return Math.floor(n)
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
  try {
    for (;;) {
      if (maxIterations != null && count >= maxIterations) return
      count += 1

      try {
        // Multi-replica safety: skip the tick if another replica holds the
        // advisory lock. Acquired-and-released per iteration so a crash
        // between ticks frees it for the next replica.
        const haveLock = await tryAcquireIndexerLock(db)
        if (!haveLock) {
          await sleep(intervalMs)
          continue
        }
        try {
          const result = await runTick({ db, rpc })
          if (result.scanned) {
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
        await sleep(intervalMs)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        consecutiveErrors += 1
        if (consecutiveErrors >= ERROR_ESCALATION_THRESHOLD) {
          log.error(
            `tick failed (${consecutiveErrors} consecutive): ${message}`,
          )
        } else {
          log.warn(`tick failed: ${message}`)
        }
        await recordIndexerError(db, message)
        await sleep(errorBackoffMs)
      }
    }
  } finally {
    reorgJob?.stop()
  }
}
