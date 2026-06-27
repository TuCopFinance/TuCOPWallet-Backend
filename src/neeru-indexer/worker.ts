import type { Pool, PoolClient } from 'pg'
import { decodeAbiParameters } from 'viem'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import {
  assertIndexerConfig,
  CONTRACT_ADDRESS,
  EVENT_A_TOPIC0,
  EVENT_B_TOPIC0,
  EVENT_C_TOPIC0,
  EVENT_D_TOPIC0,
  EVENT_TOPIC0S,
  INDEXER_GENESIS_BLOCK,
  READ_ABI,
} from './abi'
import { runReorgReconciliation } from './reorgJob'
import {
  createNeeruRpc,
  type NeeruIndexerRpcClient,
  type NeeruLog,
} from './rpc'
import {
  ensureIndexerStateSeed,
  getIndexerState,
  recordIndexerError,
  setLastScannedBlock,
} from './state'
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

const log = createLogger('neeru-indexer:worker')

const DEFAULT_TICK_INTERVAL_MS = 30_000
const DEFAULT_REORG_CHECK_INTERVAL_MS = 60_000
const ERROR_BACKOFF_MS = 5 * 60 * 1000
const REORG_BUFFER_BLOCKS = 5n
const MAX_BLOCKS_PER_BATCH = 5_000n
const REORG_RUN_UTC_HOUR = 3

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

function isNeeruCategory(value: number): value is NeeruCategory {
  return value === 0 || value === 1 || value === 2 || value === 3
}

function ensureFullAddress(value: string, label: string): string {
  const lower = value.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(lower)) {
    throw new Error(
      `neeru indexer: invalid ${label} address "${value}" - expected 0x + 40 lowercase hex`,
    )
  }
  return lower
}

function ensureFullTxHash(value: string | null, label: string): string {
  if (!value || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error(
      `neeru indexer: invalid ${label} tx hash "${value ?? '<null>'}"`,
    )
  }
  return value.toLowerCase()
}

function decodeTopicAddress(topic: string | undefined): string {
  if (!topic) throw new Error('missing topic')
  return decodeAbiParameters(
    [{ type: 'address' }],
    topic as `0x${string}`,
  )[0] as string
}

function decodeTopicUint256(topic: string | undefined): bigint {
  if (!topic) throw new Error('missing topic')
  return decodeAbiParameters(
    [{ type: 'uint256' }],
    topic as `0x${string}`,
  )[0] as bigint
}

export function parseNeeruLog(entry: NeeruLog): NeeruEventWithoutTimestamp {
  const topic0 = entry.topics[0]?.toLowerCase()
  if (!topic0) {
    throw new Error(
      `log without topic0 at tx ${entry.transactionHash ?? '<unknown>'} logIndex ${entry.logIndex ?? -1}`,
    )
  }

  const txHash = ensureFullTxHash(entry.transactionHash, 'log')
  const blockNumber = entry.blockNumber
  const logIndex = entry.logIndex ?? -1
  const data = entry.data as `0x${string}`

  switch (topic0) {
    case EVENT_A_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const id = decodeTopicUint256(entry.topics[2])
      const [d0, d1, , d3] = decodeAbiParameters(
        [
          { type: 'uint8' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        data,
      )
      const cat = Number(d0)
      if (!isNeeruCategory(cat)) {
        throw new Error(
          `kind=a: unexpected category=${cat} id=${id.toString()} tx=${txHash}`,
        )
      }
      return {
        kind: 'a',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=a user'),
        id,
        category: cat,
        amount: d1,
        endTs: d3,
      }
    }
    case EVENT_B_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const id = decodeTopicUint256(entry.topics[2])
      return {
        kind: 'b',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=b user'),
        id,
      }
    }
    case EVENT_C_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const id = decodeTopicUint256(entry.topics[2])
      return {
        kind: 'c',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=c user'),
        id,
      }
    }
    case EVENT_D_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const oldId = decodeTopicUint256(entry.topics[2])
      const newId = decodeTopicUint256(entry.topics[3])
      const [d0, , , d3] = decodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        data,
      )
      return {
        kind: 'd',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=d user'),
        oldId,
        newId,
        newAmount: d0,
        endTs: d3,
      }
    }
    default:
      throw new Error(`unexpected topic0: ${topic0}`)
  }
}

export async function buildOnchainContext(
  rpc: NeeruIndexerRpcClient,
  events: ReadonlyArray<NeeruEventWithoutTimestamp>,
): Promise<NeeruOnchainBatchContext> {
  const ctx: NeeruOnchainBatchContext = {
    positionCategory: new Map(),
    blockTimestamps: new Map(),
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
  }

  for (const blockNumberStr of uniqueBlockNumbers) {
    const blockNumber = BigInt(blockNumberStr)
    const block = await rpc.getBlock({ blockNumber })
    ctx.blockTimestamps.set(blockNumberStr, block.timestamp)
  }

  return ctx
}

function attachTimestamps(
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

  await insertRow(
    client,
    {
      id: args.newId,
      user: args.user,
      category: cat,
      amount: args.newAmount,
      startTs: args.blockTimestamp,
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

export interface TickOptions {
  db: Pool
  rpc: NeeruIndexerRpcClient
}

export function chunkBlockRange(
  from: bigint,
  to: bigint,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (from > to) return []
  const out: Array<{ fromBlock: bigint; toBlock: bigint }> = []
  let cursor = from
  while (cursor <= to) {
    const end = cursor + MAX_BLOCKS_PER_BATCH - 1n
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

  log.info(`starting neeru indexer (intervalMs=${intervalMs})`)

  let reorgJob: { stop: () => void } | null = null
  if (enableReorgJob) {
    reorgJob = scheduleReorgJob(rpc, db)
    log.info(
      `reconciliation scheduled (daily at ${REORG_RUN_UTC_HOUR}:00 UTC)`,
    )
  }

  let count = 0
  try {
    for (;;) {
      if (maxIterations != null && count >= maxIterations) return
      count += 1

      try {
        const result = await runTick({ db, rpc })
        if (result.scanned) {
          log.info(
            `tick complete: blocks=${result.fromBlock}..${result.toBlock} logs=${result.logCount}`,
          )
        }
        await sleep(intervalMs)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`tick failed: ${message}`)
        await recordIndexerError(db, message)
        await sleep(ERROR_BACKOFF_MS)
      }
    }
  } finally {
    reorgJob?.stop()
  }
}
