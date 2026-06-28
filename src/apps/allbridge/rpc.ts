import { http, fallback, createPublicClient, type PublicClient } from 'viem'
import { celo } from 'viem/chains'

export const RPC_URLS = [
  'https://rpc.celocolombia.org',
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
