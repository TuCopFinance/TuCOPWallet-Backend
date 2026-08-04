import {
  type MulticallParameters,
  type MulticallReturnType,
  type PublicClient,
  type ReadContractParameters,
  type ReadContractReturnType,
  type Abi,
  type ContractFunctionName,
  type ContractFunctionArgs,
} from 'viem'
import {
  createCeloPublicClient,
  getAnkrRpcUrl,
  getDrpcRpcUrl,
  getFornoUrl,
  getPrimaryRpcUrl,
} from '../lib/celoClient'
import { createLogger } from '../lib/logger'

const log = createLogger('neeru-indexer:rpc')

// Fallback chain order: primary -> Forno -> Ankr -> dRPC. URLs resolve
// through lib/celoClient getters, which read from env, so a Railway env
// override propagates here without a redeploy.

export const PRIMARY_SKIP_AFTER_FAILURES = 3
export const PRIMARY_SKIP_DURATION_MS = 5 * 60 * 1000

export interface NeeruGetLogsArgs {
  address: `0x${string}`
  topics: ReadonlyArray<ReadonlyArray<`0x${string}`> | `0x${string}` | null>
  fromBlock: bigint
  toBlock: bigint
}

export interface NeeruLog {
  address: string
  blockNumber: bigint
  blockHash: string | null
  transactionHash: string | null
  transactionIndex: number | null
  logIndex: number | null
  topics: ReadonlyArray<string>
  data: string
  removed: boolean
}

export interface NeeruBlockSummary {
  number: bigint
  timestamp: bigint
}

export interface NeeruCallArgs {
  from: `0x${string}`
  to: `0x${string}`
  data: `0x${string}`
}

export type NeeruCallOutcome =
  | { status: 'ok'; data: `0x${string}` }
  | { status: 'revert'; revertData: `0x${string}` | null }

export interface NeeruIndexerRpcClient {
  getBlockNumber(): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<NeeruBlockSummary>
  getLogs(args: NeeruGetLogsArgs): Promise<ReadonlyArray<NeeruLog>>
  multicall<
    const contracts extends readonly unknown[],
    allowFailure extends boolean = true,
  >(
    args: MulticallParameters<contracts, allowFailure>,
  ): Promise<MulticallReturnType<contracts, allowFailure>>
  readContract<
    const abi extends Abi | readonly unknown[],
    functionName extends ContractFunctionName<abi, 'pure' | 'view'>,
    const args extends ContractFunctionArgs<abi, 'pure' | 'view', functionName>,
  >(
    parameters: ReadContractParameters<abi, functionName, args>,
  ): Promise<ReadContractReturnType<abi, functionName, args>>
  // Raw eth_call that surfaces contract-level reverts as `{status:'revert', revertData}`
  // instead of throwing. RPC / network failures still throw (via withFallback).
  // Used by hooks-api to simulate mutating shortcut txs before returning
  // calldata to the wallet, so the wallet does not pay gas for a tx that will
  // revert with a known custom error.
  call(args: NeeruCallArgs): Promise<NeeruCallOutcome>
}

type EndpointName = 'primary' | 'forno' | 'ankr' | 'drpc'

interface Endpoint {
  name: EndpointName
  url: string
  client: PublicClient
}

interface PrimaryState {
  consecutiveFailures: number
  skipUntilMs: number | null
}

function makeClient(url: string): PublicClient {
  return createCeloPublicClient({ url })
}

export interface CreateNeeruRpcOptions {
  endpoints?: {
    primary?: PublicClient
    forno?: PublicClient
    ankr?: PublicClient
    drpc?: PublicClient
  }
  now?: () => number
}

export function createNeeruRpc(
  options: CreateNeeruRpcOptions = {},
): NeeruIndexerRpcClient {
  const now = options.now ?? (() => Date.now())

  const primaryUrl = getPrimaryRpcUrl()
  const fornoUrl = getFornoUrl()
  const ankrUrl = getAnkrRpcUrl()
  const drpcUrl = getDrpcRpcUrl()

  // Order matters: withFallback iterates this array and returns the first
  // client that answers without throwing. Forno first because it is the
  // canonical public Celo RPC and has been the most reliable endpoint in
  // observation. drpc + ankr next as diverse-provider fallbacks. `primary`
  // (rpc.celocolombia.org today) kept in the chain as last resort because
  // it degrades non-obviously (has been observed returning block=0 while
  // still 200-OK on the wire), so we want the 3-consecutive-failure skip
  // window applied to it rather than to a healthy endpoint. See journal
  // entry 2026-08-03 for the incident that motivated this ordering.
  const endpoints: Endpoint[] = [
    {
      name: 'forno',
      url: fornoUrl,
      client: options.endpoints?.forno ?? makeClient(fornoUrl),
    },
    {
      name: 'drpc',
      url: drpcUrl,
      client: options.endpoints?.drpc ?? makeClient(drpcUrl),
    },
    {
      name: 'ankr',
      url: ankrUrl,
      client: options.endpoints?.ankr ?? makeClient(ankrUrl),
    },
    {
      name: 'primary',
      url: primaryUrl,
      client: options.endpoints?.primary ?? makeClient(primaryUrl),
    },
  ]

  const primaryState: PrimaryState = {
    consecutiveFailures: 0,
    skipUntilMs: null,
  }

  function primaryIsSkipped(): boolean {
    if (primaryState.skipUntilMs == null) return false
    if (now() >= primaryState.skipUntilMs) {
      primaryState.skipUntilMs = null
      primaryState.consecutiveFailures = 0
      return false
    }
    return true
  }

  function recordPrimaryFailure(): void {
    primaryState.consecutiveFailures += 1
    if (primaryState.consecutiveFailures >= PRIMARY_SKIP_AFTER_FAILURES) {
      primaryState.skipUntilMs = now() + PRIMARY_SKIP_DURATION_MS
      log.warn(
        `Primary RPC (${primaryUrl}) skipped for ${PRIMARY_SKIP_DURATION_MS}ms after ${primaryState.consecutiveFailures} consecutive failures`,
      )
    }
  }

  function recordPrimarySuccess(): void {
    primaryState.consecutiveFailures = 0
    primaryState.skipUntilMs = null
  }

  async function withFallback<T>(
    label: string,
    invoke: (client: PublicClient) => Promise<T>,
  ): Promise<T> {
    const errors: Array<{ endpoint: string; error: string }> = []
    for (const endpoint of endpoints) {
      if (endpoint.name === 'primary' && primaryIsSkipped()) {
        continue
      }
      try {
        const result = await invoke(endpoint.client)
        if (endpoint.name === 'primary') recordPrimarySuccess()
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ endpoint: endpoint.url, error: message })
        if (endpoint.name === 'primary') recordPrimaryFailure()
        log.warn(
          `RPC ${label} failed on ${endpoint.url}: ${message} - falling back`,
        )
      }
    }
    const summary = errors
      .map((e) => `${e.endpoint}: ${e.error}`)
      .join(' | ')
    throw new Error(`all Neeru RPC endpoints failed for ${label} - ${summary}`)
  }

  return {
    async getBlockNumber(): Promise<bigint> {
      // Sanity-check the return value before handing it to the worker.
      // A silently-degraded RPC (observed 2026-08-03 on the previous
      // "primary" endpoint) can respond HTTP 200 with block=0, which
      // withFallback would otherwise treat as a valid successful result
      // and never cascade. Throwing here turns the bad-data case into an
      // exception the fallback iterator handles like any other RPC error.
      return withFallback('getBlockNumber', async (client) => {
        const block = await client.getBlockNumber()
        if (block <= 0n) {
          throw new Error(
            `RPC returned implausible block number ${block.toString()} - refusing to trust`,
          )
        }
        return block
      })
    },

    async getBlock(args): Promise<NeeruBlockSummary> {
      // Same defensive rationale as getBlockNumber: reject implausible
      // return shapes (block.number = 0 or block.timestamp = 0) so a
      // silently-degraded RPC cascades instead of being trusted.
      return withFallback('getBlock', async (client) => {
        const block = await client.getBlock({
          blockNumber: args.blockNumber,
          includeTransactions: false,
        })
        if (block.number <= 0n || block.timestamp <= 0n) {
          throw new Error(
            `RPC returned implausible block { number: ${block.number.toString()}, timestamp: ${block.timestamp.toString()} } for requested ${args.blockNumber.toString()} - refusing to trust`,
          )
        }
        return { number: block.number, timestamp: block.timestamp }
      })
    },

    async getLogs(args: NeeruGetLogsArgs): Promise<ReadonlyArray<NeeruLog>> {
      return withFallback('getLogs', async (client) => {
        const result = (await client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: args.address,
              topics: args.topics as unknown as `0x${string}`[],
              fromBlock: `0x${args.fromBlock.toString(16)}` as `0x${string}`,
              toBlock: `0x${args.toBlock.toString(16)}` as `0x${string}`,
            },
          ],
        })) as Array<{
          address: string
          blockNumber: string | null
          blockHash: string | null
          transactionHash: string | null
          transactionIndex: string | null
          logIndex: string | null
          topics: string[]
          data: string
          removed?: boolean
        }>

        return result.map<NeeruLog>((entry) => ({
          address: entry.address,
          blockNumber: entry.blockNumber ? BigInt(entry.blockNumber) : 0n,
          blockHash: entry.blockHash,
          transactionHash: entry.transactionHash,
          transactionIndex:
            entry.transactionIndex != null
              ? Number(BigInt(entry.transactionIndex))
              : null,
          logIndex:
            entry.logIndex != null ? Number(BigInt(entry.logIndex)) : null,
          topics: entry.topics,
          data: entry.data,
          removed: entry.removed === true,
        }))
      })
    },

    async multicall(args) {
      return withFallback('multicall', (client) =>
        client.multicall(args as Parameters<PublicClient['multicall']>[0]),
      ) as ReturnType<NeeruIndexerRpcClient['multicall']>
    },

    async readContract(args) {
      return withFallback('readContract', (client) =>
        client.readContract(
          args as Parameters<PublicClient['readContract']>[0],
        ),
      ) as ReturnType<NeeruIndexerRpcClient['readContract']>
    },

    async call(args: NeeruCallArgs): Promise<NeeruCallOutcome> {
      return withFallback('call', async (client): Promise<NeeruCallOutcome> => {
        try {
          const result = await client.call({
            account: args.from,
            to: args.to,
            data: args.data,
          })
          // viem returns { data: '0x' | undefined } on a successful call.
          return { status: 'ok', data: (result.data ?? '0x') as `0x${string}` }
        } catch (err) {
          // Contract-level revert: viem wraps as CallExecutionError with a
          // RawContractError cause carrying `data`. We only shortcut the flow
          // for contract reverts; RPC / network failures rethrow so
          // withFallback rotates to the next endpoint.
          const revertData = extractRevertData(err)
          if (revertData !== undefined) {
            return { status: 'revert', revertData }
          }
          throw err
        }
      })
    },
  } as NeeruIndexerRpcClient
}

// Returns:
//   - a Hex string (possibly '0x' for a reason-less revert) when the error
//     is a contract-level revert, so callers can inspect the 4-byte selector
//   - `null` when the underlying error looks like a revert but has no data
//   - `undefined` when the error is not a contract revert (RPC / network
//     failure); caller should treat as retryable and let withFallback rotate
export function extractRevertData(err: unknown): `0x${string}` | null | undefined {
  // Walk the cause chain looking for a RawContractError (or anything with
  // a `data` property matching viem's shape). We do not import viem's error
  // classes directly because their identity changes across major versions;
  // duck-typing on `.data` is safer.
  let node: unknown = err
  const seen = new Set<unknown>()
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node)
    const rec = node as { data?: unknown; cause?: unknown; name?: unknown }
    if (typeof rec.data === 'string' && rec.data.startsWith('0x')) {
      return rec.data as `0x${string}`
    }
    if (rec.data && typeof rec.data === 'object') {
      const nested = (rec.data as { data?: unknown }).data
      if (typeof nested === 'string' && nested.startsWith('0x')) {
        return nested as `0x${string}`
      }
    }
    // If it walks like a revert but has no data, tag as null so caller can
    // still treat it as revert-without-selector.
    if (typeof rec.name === 'string' && /revert|contract/i.test(rec.name)) {
      // Continue walking; only return null if we exhaust the chain below.
    }
    node = rec.cause
  }
  // Fallback string match for providers that surface revert only in message.
  if (err instanceof Error && /execution reverted|revert/i.test(err.message)) {
    return null
  }
  return undefined
}
