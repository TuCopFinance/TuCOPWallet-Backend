import { createPublicClient, http, type PublicClient, type Transport } from 'viem'
import { celo } from 'viem/chains'

// Single source of truth for Celo public-client construction. Wrappers that
// need a wallet/auth client (e.g. WRI relay) keep their own builder; this one
// is for read-only paths (RPC fallback chain, indexer, allbridge reads).

export interface CreateCeloClientOptions {
  url?: string
}

export function createCeloPublicClient(
  options: CreateCeloClientOptions = {},
): PublicClient {
  const transport: Transport = options.url ? http(options.url) : http()
  return createPublicClient({ chain: celo, transport }) as unknown as PublicClient
}

export const FORNO_URL = 'https://forno.celo.org'
export const PRIMARY_RPC_URL = 'https://rpc.celocolombia.org'
export const ANKR_RPC_URL = 'https://rpc.ankr.com/celo'
export const DRPC_RPC_URL = 'https://celo.drpc.org'

// Canonical fallback chain for Celo public-client reads. Order matters:
// primary first (lowest-latency for us), then the public providers in
// decreasing preference. Both the Neeru indexer (custom skip-after-failure
// supervisor) and the Allbridge route (viem's fallback transport) consume
// this list. Single source of truth - do NOT redefine in other modules.
export const CELO_RPC_FALLBACK_URLS = [
  PRIMARY_RPC_URL,
  FORNO_URL,
  ANKR_RPC_URL,
  DRPC_RPC_URL,
] as const

export function getFornoUrl(): string {
  return process.env.FORNO_URL || FORNO_URL
}

// Cached singleton client for shared read-only probes (health checks,
// metrics, occasional one-shot reads). Long-running consumers (indexer,
// WRI relay) still build their own client with custom fallback chains.
let cachedClient: PublicClient | null = null

export function getCeloPublicClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createCeloPublicClient({ url: getFornoUrl() })
  }
  return cachedClient
}

export function _resetCeloClientForTests(): void {
  cachedClient = null
}
