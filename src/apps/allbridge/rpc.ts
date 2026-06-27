// Local RPC client for the Allbridge port. Wraps viem's `fallback`
// transport across the 3 endpoints listed in
// tasks/plans/tucop-hooks-api-neeru-vaults.md section 2.3.
//
// TODO: consolidate with shared RPC helper after PR 1 merges. PR 1
// introduces `src/neeru-indexer/rpc.ts` with a hand-rolled 5-minute
// Forno-skip on top of `fallback` (the upstream transport only retries
// per-request). Until then this file uses viem's built-in retry +
// fallback, which covers the happy path and the "skip dead RPC for the
// rest of this request" path. The cross-request circuit breaker lands
// in the shared helper.

import { http, fallback, createPublicClient, type PublicClient } from 'viem'
import { celo } from 'viem/chains'

export const RPC_URLS = [
  'https://forno.celo.org',
  'https://rpc.ankr.com/celo',
  'https://celo.drpc.org',
] as const

let cached: PublicClient | null = null

export function getCeloPublicClient(): PublicClient {
  if (cached) return cached
  const transport = fallback(
    RPC_URLS.map((url) =>
      http(url, {
        // viem default is 3; one retry per fallback URL is enough since
        // the fallback layer also retries downstream.
        retryCount: 1,
        timeout: 10_000,
      }),
    ),
    { rank: false },
  )
  cached = createPublicClient({ chain: celo, transport }) as PublicClient
  return cached
}

// Test-only escape hatch. Replaces the cached client so tests can inject
// a mock without monkey-patching viem.
export function __setCeloPublicClientForTests(client: PublicClient | null): void {
  cached = client
}
