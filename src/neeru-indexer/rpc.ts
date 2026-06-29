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
  FORNO_URL as FORNO_DEFAULT_URL,
} from '../lib/celoClient'
import { createLogger } from '../lib/logger'

const log = createLogger('neeru-indexer:rpc')

export const PRIMARY_URL = 'https://rpc.celocolombia.org'
// Indexer falls back through Forno -> Ankr -> dRPC if the primary is down.
// FORNO_URL is exported so callers can keep importing it; the actual URL used
// is `process.env.FORNO_URL || default` via the helper.
export const FORNO_URL = FORNO_DEFAULT_URL
export const ANKR_URL = 'https://rpc.ankr.com/celo'
export const DRPC_URL = 'https://celo.drpc.org'

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

  const endpoints: Endpoint[] = [
    {
      name: 'primary',
      url: PRIMARY_URL,
      client: options.endpoints?.primary ?? makeClient(PRIMARY_URL),
    },
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
        `Primary RPC (${PRIMARY_URL}) skipped for ${PRIMARY_SKIP_DURATION_MS}ms after ${primaryState.consecutiveFailures} consecutive failures`,
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
