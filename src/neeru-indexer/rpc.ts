// Neeru indexer RPC client with a 3-endpoint fallback chain.
//
// Order is Forno -> Ankr -> dRPC. If Forno produces 3 consecutive failures we
// skip it for 5 minutes before reattempting. The exposed surface is the
// `NeeruIndexerRpcClient` interface (subset of viem `PublicClient`) so unit
// tests can pass mocks without dragging in transport plumbing.

import {
  createPublicClient,
  http,
  type MulticallParameters,
  type MulticallReturnType,
  type PublicClient,
  type ReadContractParameters,
  type ReadContractReturnType,
  type Abi,
  type ContractFunctionName,
  type ContractFunctionArgs,
} from 'viem'
import { celo } from 'viem/chains'
import { createLogger } from '../lib/logger'

const log = createLogger('neeru-indexer:rpc')

export const FORNO_URL = 'https://forno.celo.org'
export const ANKR_URL = 'https://rpc.ankr.com/celo'
export const DRPC_URL = 'https://celo.drpc.org'

export const FORNO_SKIP_AFTER_FAILURES = 3
export const FORNO_SKIP_DURATION_MS = 5 * 60 * 1000

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

// Minimal surface the worker needs from the RPC layer.
// Mirrors `IndexerRpcClient` in src/transactions-indexer/worker.ts:23-51.
export interface NeeruBlockSummary {
  number: bigint
  timestamp: bigint
}

export interface NeeruIndexerRpcClient {
  getBlockNumber(): Promise<bigint>
  // Lightweight block lookup. PR 2 only needs the timestamp; declaring the
  // narrow shape here avoids dragging the full viem block type into mocks.
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
}

interface Endpoint {
  name: 'forno' | 'ankr' | 'drpc'
  url: string
  client: PublicClient
}

interface FornoState {
  consecutiveFailures: number
  skipUntilMs: number | null
}

function makeClient(url: string): PublicClient {
  return createPublicClient({
    chain: celo,
    transport: http(url),
  }) as unknown as PublicClient
}

export interface CreateNeeruRpcOptions {
  // Test seam: lets unit tests inject custom clients per endpoint without
  // exercising the real network stack.
  endpoints?: {
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

  const endpoints: Endpoint[] = [
    {
      name: 'forno',
      url: FORNO_URL,
      client: options.endpoints?.forno ?? makeClient(FORNO_URL),
    },
    {
      name: 'ankr',
      url: ANKR_URL,
      client: options.endpoints?.ankr ?? makeClient(ANKR_URL),
    },
    {
      name: 'drpc',
      url: DRPC_URL,
      client: options.endpoints?.drpc ?? makeClient(DRPC_URL),
    },
  ]

  const fornoState: FornoState = {
    consecutiveFailures: 0,
    skipUntilMs: null,
  }

  function fornoIsSkipped(): boolean {
    if (fornoState.skipUntilMs == null) return false
    if (now() >= fornoState.skipUntilMs) {
      fornoState.skipUntilMs = null
      fornoState.consecutiveFailures = 0
      return false
    }
    return true
  }

  function recordFornoFailure(): void {
    fornoState.consecutiveFailures += 1
    if (fornoState.consecutiveFailures >= FORNO_SKIP_AFTER_FAILURES) {
      fornoState.skipUntilMs = now() + FORNO_SKIP_DURATION_MS
      log.warn(
        `Forno (${FORNO_URL}) skipped for ${FORNO_SKIP_DURATION_MS}ms after ${fornoState.consecutiveFailures} consecutive failures`,
      )
    }
  }

  function recordFornoSuccess(): void {
    fornoState.consecutiveFailures = 0
    fornoState.skipUntilMs = null
  }

  async function withFallback<T>(
    label: string,
    invoke: (client: PublicClient) => Promise<T>,
  ): Promise<T> {
    const errors: Array<{ endpoint: string; error: string }> = []
    for (const endpoint of endpoints) {
      if (endpoint.name === 'forno' && fornoIsSkipped()) {
        continue
      }
      try {
        const result = await invoke(endpoint.client)
        if (endpoint.name === 'forno') recordFornoSuccess()
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ endpoint: endpoint.url, error: message })
        if (endpoint.name === 'forno') recordFornoFailure()
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
      return withFallback('getBlockNumber', (client) => client.getBlockNumber())
    },

    async getBlock(args): Promise<NeeruBlockSummary> {
      return withFallback('getBlock', async (client) => {
        const block = await client.getBlock({
          blockNumber: args.blockNumber,
          includeTransactions: false,
        })
        return { number: block.number, timestamp: block.timestamp }
      })
    },

    async getLogs(args: NeeruGetLogsArgs): Promise<ReadonlyArray<NeeruLog>> {
      return withFallback('getLogs', async (client) => {
        // viem's getLogs typing is event-aware; the worker passes raw topic
        // strings, so we go through `request` which returns the wire-format
        // log objects and normalise to our `NeeruLog` shape.
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
  } as NeeruIndexerRpcClient
}
