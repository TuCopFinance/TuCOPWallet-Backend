import { createPublicClient, http, type PublicClient, type Transport } from 'viem'
import { celo } from 'viem/chains'
import { env } from './env'

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

// Env-aware getters. Every consumer reads through these so that setting the
// env var on the deployment (Railway) propagates everywhere, including the
// fallback chain used by Neeru indexer and Allbridge. Defaults live in
// lib/env.ts so the zod schema is the single source for both validation and
// default values.

export function getPrimaryRpcUrl(): string {
  return env.PRIMARY_RPC_URL
}

export function getFornoUrl(): string {
  return env.FORNO_URL
}

export function getAnkrRpcUrl(): string {
  return env.ANKR_RPC_URL
}

export function getDrpcRpcUrl(): string {
  return env.DRPC_RPC_URL
}

// Canonical fallback chain for Celo public-client reads. Order matters:
// primary first (lowest-latency for us), then the public providers in
// decreasing preference. Both the Neeru indexer (custom skip-after-failure
// supervisor) and the Allbridge route (viem's fallback transport) consume
// this list. Single source of truth - do NOT redefine in other modules.
export function getCeloRpcFallbackUrls(): readonly string[] {
  return [
    getPrimaryRpcUrl(),
    getFornoUrl(),
    getAnkrRpcUrl(),
    getDrpcRpcUrl(),
  ]
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
