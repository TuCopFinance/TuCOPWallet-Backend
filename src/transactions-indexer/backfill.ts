import type { Pool } from 'pg'
import type { Hash } from 'viem'
import { createCeloPublicClient, getFornoUrl } from '../lib/celoClient'
import { env } from '../lib/env'
import { createLogger } from '../lib/logger'
import { persistTx } from './persist'

// Historical backfill for an address registered via POST /api/transactions/watch.
//
// Strategy: walk back env.TX_INDEXER_BACKFILL_BLOCKS (default 10_000,
// ~14 h on Celo's 5 s blocks) and ask the RPC for ERC20 Transfer logs that
// touch the address as either `from` (topic1) or `to` (topic2). For each
// matching log we re-fetch the tx + receipt and write through persist.ts,
// so the row shape is identical to what the live worker produces.
//
// Native CELO sends (input == "0x", value > 0) are NOT discovered by this
// method - acceptable for an MVP since real TuCop users pay gas in stables
// and native sends are vanishingly rare. The live worker still catches them
// going forward.
//
// Runs fire-and-forget: the HTTP route returns immediately with
// `backfillStartedAt` and a background task does the work. Errors are
// logged but do not propagate; the worst case is `backfill_completed_at`
// stays NULL and an operator can DELETE + re-watch to retry.

const log = createLogger('indexer:backfill')

const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// Celo public RPCs cap eth_getLogs at 5000 blocks per request. Same constant
// the Neeru indexer pinned in #19 after the first live deploy failed silently
// behind the 3-RPC fallback chain.
const LOG_BATCH_BLOCKS = 5_000

// In-process dedupe: a second /watch hit on the same address while a
// backfill is still running should not spawn a second job. The Set is
// process-local; multi-instance deploys race the SQL update (idempotent) and
// at most do duplicate work, no corruption.
const inProgress = new Set<string>()

// Minimal RPC surface we use. Defined as an interface so unit tests can
// inject a mocked client without dragging in viem's chain plumbing.
export interface BackfillRpcClient {
  getBlockNumber(): Promise<bigint>
  getLogs(args: {
    fromBlock: bigint
    toBlock: bigint
    topics: ReadonlyArray<string | string[] | null>
  }): Promise<
    ReadonlyArray<{
      // Plain string (not viem's `0x${string}` template) so test mocks can
      // synthesize hashes without ceremony. We lowercase and dedupe on the
      // next line anyway.
      transactionHash: string
      blockNumber: bigint
    }>
  >
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
  getTransaction(args: { hash: Hash }): Promise<{
    hash: Hash
    from: string
    to: string | null
    transactionIndex: number | null
    value: bigint
    input: string
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

// Minimal subset of viem's PublicClient we touch when wrapping it as a
// BackfillRpcClient. Defined locally so tests can build a stand-in without
// dragging viem into the test fixture.
export interface BackfillViemLike {
  getBlockNumber(): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
  getTransaction(args: { hash: `0x${string}` }): Promise<{
    hash: `0x${string}`
    from: string
    to: string | null
    transactionIndex: number | null
    value: bigint
    input: string
    blockNumber?: bigint
  }>
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: 'success' | 'reverted'
    transactionIndex: number
    gasUsed: bigint
    effectiveGasPrice?: bigint
    logs: ReadonlyArray<{
      logIndex: number | null
      address: string
      topics: ReadonlyArray<string>
      data: string
    }>
  }>
  request(args: { method: string; params: unknown }): Promise<unknown>
}

// Wraps a viem PublicClient as a BackfillRpcClient. The reason this exists
// rather than a direct cast: viem's typed `getLogs(...)` does NOT accept the
// `topics: [...]` shape we need for an unindexed-event-style ERC20 Transfer
// query; the typed method silently drops the filter, so Forno gets
// `topics: []` (match-everything) and times out at 30s on every 5000-block
// chunk. We translate to JSON-RPC `eth_getLogs` via `client.request` and
// keep the BackfillRpcClient surface stable. Same pattern that
// `src/neeru-indexer/rpc.ts` ships in production.
export function wrapPublicClientAsBackfillRpc(
  client: BackfillViemLike,
): BackfillRpcClient {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getLogs: async (args) => {
      const result = (await client.request({
        method: 'eth_getLogs',
        params: [
          {
            topics: args.topics as `0x${string}`[],
            fromBlock: `0x${args.fromBlock.toString(16)}` as `0x${string}`,
            toBlock: `0x${args.toBlock.toString(16)}` as `0x${string}`,
          },
        ],
      })) as Array<{ transactionHash: string; blockNumber: string | null }>
      return result.map((r) => ({
        transactionHash: r.transactionHash,
        blockNumber: r.blockNumber ? BigInt(r.blockNumber) : 0n,
      }))
    },
    getBlock: (args) =>
      client
        .getBlock({ blockNumber: args.blockNumber })
        .then((b) => ({ timestamp: b.timestamp })),
    getTransaction: (args) => client.getTransaction({ hash: args.hash }),
    getTransactionReceipt: (args) =>
      client.getTransactionReceipt({ hash: args.hash }).then((r) => ({
        status: r.status,
        transactionIndex: r.transactionIndex,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        logs: r.logs.map((lg) => ({
          logIndex: lg.logIndex,
          address: lg.address,
          topics: lg.topics,
          data: lg.data,
        })),
      })),
  }
}

function buildDefaultClient(): BackfillRpcClient {
  return wrapPublicClientAsBackfillRpc(
    createCeloPublicClient({ url: getFornoUrl() }) as unknown as BackfillViemLike,
  )
}

function paddedAddressTopic(address: string): string {
  // ERC20 Transfer topics encode the address as a 32-byte word (12 bytes of
  // zero padding + 20-byte address). Lowercase to match how the worker
  // writes topics into Postgres.
  return '0x' + '0'.repeat(24) + address.slice(2).toLowerCase()
}

export interface BackfillResult {
  blocksScanned: number
  txsFound: number
}

export interface BackfillOptions {
  rpc?: BackfillRpcClient
  depthBlocks?: number
}

export async function backfillAddress(
  db: Pool,
  address: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const userAddress = address.toLowerCase()
  const rpc = options.rpc ?? buildDefaultClient()
  const depth = BigInt(options.depthBlocks ?? env.TX_INDEXER_BACKFILL_BLOCKS)

  const tip = await rpc.getBlockNumber()
  const fromBlock = tip > depth ? tip - depth : 0n
  const toBlock = tip

  const topicAddress = paddedAddressTopic(userAddress)
  // Two separate eth_getLogs calls: one for outbound (topic1 = user) and one
  // for inbound (topic2 = user). Most RPCs do not support an OR across
  // different topic slots in a single request, so we union client-side.
  const seenHashes = new Set<string>()

  for (
    let chunkStart = fromBlock;
    chunkStart <= toBlock;
    chunkStart += BigInt(LOG_BATCH_BLOCKS)
  ) {
    const chunkEnd =
      chunkStart + BigInt(LOG_BATCH_BLOCKS) - 1n > toBlock
        ? toBlock
        : chunkStart + BigInt(LOG_BATCH_BLOCKS) - 1n

    const [outboundLogs, inboundLogs] = await Promise.all([
      rpc.getLogs({
        fromBlock: chunkStart,
        toBlock: chunkEnd,
        topics: [ERC20_TRANSFER_TOPIC0, topicAddress, null],
      }),
      rpc.getLogs({
        fromBlock: chunkStart,
        toBlock: chunkEnd,
        topics: [ERC20_TRANSFER_TOPIC0, null, topicAddress],
      }),
    ])

    for (const lg of [...outboundLogs, ...inboundLogs]) {
      seenHashes.add(lg.transactionHash.toLowerCase())
    }
  }

  let txsFound = 0
  for (const hash of seenHashes) {
    try {
      const [tx, receipt] = await Promise.all([
        rpc.getTransaction({ hash: hash as Hash }),
        rpc.getTransactionReceipt({ hash: hash as Hash }),
      ])
      // viem's getTransaction returns blockNumber on the tx object. We typed
      // BackfillRpcClient narrowly; widen via a safe cast.
      const txWithBlock = tx as typeof tx & { blockNumber?: bigint }
      const blockNumber = txWithBlock.blockNumber ?? null
      if (blockNumber === null) {
        log.warn(`backfill: tx ${hash} has no blockNumber; skipping`)
        continue
      }
      const block = await rpc.getBlock({ blockNumber })
      const blockTimestampMs = Number(block.timestamp) * 1000

      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await persistTx(client, {
          tx: {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            transactionIndex: tx.transactionIndex,
            value: tx.value,
            input: tx.input,
          },
          blockNumber,
          blockTimestampMs,
          receipt,
        })
        await client.query('COMMIT')
        txsFound += 1
      } catch (err) {
        await client.query('ROLLBACK')
        log.warn(
          `backfill: persist failed for tx ${hash}: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        client.release()
      }
    } catch (err) {
      log.warn(
        `backfill: rpc lookup failed for tx ${hash}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const blocksScanned = Number(toBlock - fromBlock + 1n)
  return { blocksScanned, txsFound }
}

/**
 * Fire-and-forget trigger called by the POST /watch route. Does NOT throw.
 *
 * Steps:
 * 1. Dedupe via in-process Set (early return if already running).
 * 2. Run backfillAddress.
 * 3. Mark watched_address.backfill_completed_at on success.
 *
 * Caller does not await this; the HTTP response goes out immediately.
 */
export function triggerBackfill(
  db: Pool,
  address: string,
  options: BackfillOptions = {},
): void {
  const userAddress = address.toLowerCase()
  if (inProgress.has(userAddress)) return
  inProgress.add(userAddress)

  void (async () => {
    try {
      log.info(`backfill start for ${userAddress}`)
      const result = await backfillAddress(db, userAddress, options)
      await db.query(
        `UPDATE watched_address
           SET backfill_completed_at = now()
         WHERE address = $1`,
        [userAddress],
      )
      log.info(
        `backfill done for ${userAddress}: blocksScanned=${result.blocksScanned} txsFound=${result.txsFound}`,
      )
    } catch (err) {
      log.error(
        `backfill failed for ${userAddress}: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      inProgress.delete(userAddress)
    }
  })()
}

export const _testHelpers = {
  isInProgress(address: string): boolean {
    return inProgress.has(address.toLowerCase())
  },
  clearInProgress(): void {
    inProgress.clear()
  },
}
