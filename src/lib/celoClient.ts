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

export function getFornoUrl(): string {
  return process.env.FORNO_URL || FORNO_URL
}
