import type { Pool } from 'pg'
import { getDb } from '../lib/db'
import { env } from '../lib/env'
import { createLogger } from '../lib/logger'
import {
  createNeeruRpc,
  type NeeruIndexerRpcClient,
} from '../neeru-indexer/rpc'
import {
  assertTimelockConfig,
  NEERU_CONTRACT_ADDRESS,
  TIMELOCK_ADDRESS,
  TIMELOCK_GENESIS_BLOCK,
  TIMELOCK_TOPIC0S,
} from './abi'
import { parseTimelockLog } from './parser'
import {
  dispatchTimelockEvent,
  releaseTimelockLock,
  tryAcquireTimelockLock,
} from './persistence'
import {
  ensureTimelockStateSeed,
  getTimelockState,
  recordTimelockError,
  setLastScannedBlock,
} from './state'
import type { RawLog, TimelockEventWithTimestamp } from './types'

const log = createLogger('neeru-timelock:worker')

const REORG_BUFFER_BLOCKS = 5n
const ERROR_ESCALATION_THRESHOLD = 5

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
  batchSize: bigint = env.NEERU_TIMELOCK_MAX_BLOCKS_PER_BATCH,
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

async function attachTimestamps(
  rpc: NeeruIndexerRpcClient,
  events: ReadonlyArray<ReturnType<typeof parseTimelockLog>>,
): Promise<TimelockEventWithTimestamp[]> {
  const uniqueBlocks = new Set<string>()
  for (const ev of events) uniqueBlocks.add(ev.blockNumber.toString())
  const timestamps = new Map<string, bigint>()
  for (const blockNumberStr of uniqueBlocks) {
    const blockNumber = BigInt(blockNumberStr)
    const block = await rpc.getBlock({ blockNumber })
    timestamps.set(blockNumberStr, block.timestamp)
  }
  return events.map((event) => {
    const ts = timestamps.get(event.blockNumber.toString())
    if (ts == null) {
      throw new Error(
        `timelock indexer: missing block timestamp for blockNumber=${event.blockNumber.toString()} txHash=${event.txHash} logIndex=${event.logIndex}`,
      )
    }
    return { event, blockTimestamp: ts }
  })
}

export async function runTick(opts: TickOptions): Promise<{
  scanned: boolean
  fromBlock?: bigint
  toBlock?: bigint
  logCount?: number
}> {
  const state = await getTimelockState(opts.db)
  if (!state) {
    throw new Error(
      'neeru_timelock_state row missing - migration not applied or row deleted',
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
    const logs = (await opts.rpc.getLogs({
      address: TIMELOCK_ADDRESS as `0x${string}`,
      topics: [TIMELOCK_TOPIC0S as unknown as `0x${string}`[]],
      fromBlock: batch.fromBlock,
      toBlock: batch.toBlock,
    })) as unknown as RawLog[]
    totalLogs += logs.length

    const parsed = logs.map(parseTimelockLog)
    const withTimestamps = await attachTimestamps(opts.rpc, parsed)

    const client = await opts.db.connect()
    try {
      await client.query('BEGIN')
      for (const event of withTimestamps) {
        await dispatchTimelockEvent(client, event, NEERU_CONTRACT_ADDRESS)
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

export interface StartTimelockIndexerOptions {
  db?: Pool
  rpc?: NeeruIndexerRpcClient
  intervalMs?: number
  iterations?: number
  errorBackoffMs?: number
}

export async function startTimelockIndexer(
  options: StartTimelockIndexerOptions = {},
): Promise<void> {
  const db = options.db ?? getDb()
  if (!db) {
    log.warn('DATABASE_URL not configured; timelock indexer is a no-op')
    return
  }

  assertTimelockConfig()
  await ensureTimelockStateSeed(db, TIMELOCK_GENESIS_BLOCK - 1n)

  const rpc = options.rpc ?? createNeeruRpc()
  const intervalMs = options.intervalMs ?? env.NEERU_TIMELOCK_INTERVAL_MS
  const maxIterations = options.iterations
  const errorBackoffMs =
    options.errorBackoffMs ?? env.NEERU_TIMELOCK_ERROR_BACKOFF_MS

  log.info(`starting timelock indexer (intervalMs=${intervalMs})`)

  let count = 0
  let consecutiveErrors = 0
  for (;;) {
    if (maxIterations != null && count >= maxIterations) return
    count += 1

    try {
      const haveLock = await tryAcquireTimelockLock(db)
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
        await releaseTimelockLock(db).catch((err) => {
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
      await recordTimelockError(db, message)
      await sleep(errorBackoffMs)
    }
  }
}
