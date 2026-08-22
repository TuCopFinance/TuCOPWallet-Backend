import type { PublicClient } from 'viem'
import {
  createCeloPublicClient,
  getCeloRpcFallbackUrls,
} from './celoClient'
import { createLogger } from './logger'
import { celoRpcEndpointUsedTotal } from './metrics'
import { Sentry } from './sentry'

// Shared Celo RPC fallback executor for consumers that need every read to
// survive Cloudflare 1015 / 429s / timeouts against any single endpoint.
//
// Design (mirrors `src/neeru-indexer/rpc.ts` which has been production-proven
// for the Neeru indexer since #19):
//
//   - Endpoints are tried in the canonical order defined by
//     `getCeloRpcFallbackUrls()` (primary -> forno -> ankr -> drpc).
//   - Each endpoint has its own consecutive-failure counter. After
//     `SKIP_AFTER_FAILURES` consecutive failures the endpoint is skipped
//     for `SKIP_DURATION_MS` before being reconsidered. A success at any
//     time resets the counter.
//   - `withFallback` iterates the endpoint list and calls the caller's
//     `invoke(client)` on each until one succeeds. Throws only when every
//     non-skipped endpoint has failed.
//
// The tx-indexer backfill consumes this so a long-running scan doesn't die
// on a single provider's rate limit. The Neeru indexer's own copy stays
// intact to avoid churn on the already-shipped indexer; a follow-up can
// migrate it to consume this shared helper.

const log = createLogger('lib:celo-rpc-fallback')

const SKIP_AFTER_FAILURES = 3
const SKIP_DURATION_MS = 5 * 60 * 1000

// Derive a low-cardinality provider name for metrics/spans from a URL so
// per-endpoint outcomes group nicely on Grafana + Sentry without leaking
// full URLs into label values. Unknown URLs fall back to 'other' rather
// than blowing up label cardinality with random hostnames.
function providerNameFromUrl(url: string): string {
  const lower = url.toLowerCase()
  if (lower.includes('publicnode.com')) return 'publicnode'
  if (lower.includes('alchemy.com')) return 'alchemy'
  if (lower.includes('forno.celo.org')) return 'forno'
  if (lower.includes('blockscout.com')) return 'blockscout'
  if (lower.includes('thirdweb.com')) return 'thirdweb'
  if (lower.includes('ankr.com')) return 'ankr'
  if (lower.includes('drpc.org')) return 'drpc'
  if (lower.includes('celocolombia')) return 'primary'
  return 'other'
}

export interface FallbackExecutor {
  withFallback<T>(
    label: string,
    invoke: (client: PublicClient) => Promise<T>,
  ): Promise<T>
  // Introspection for tests / metrics. Returns endpoints currently in the
  // skip window, keyed by URL.
  getSkippedEndpoints(): ReadonlyArray<{ url: string; skipUntilMs: number }>
}

interface EndpointState {
  url: string
  client: PublicClient
  consecutiveFailures: number
  skipUntilMs: number | null
}

export interface CreateExecutorOptions {
  urls?: readonly string[]
  now?: () => number
  clientFactory?: (url: string) => PublicClient
}

export function createCeloFallbackExecutor(
  options: CreateExecutorOptions = {},
): FallbackExecutor {
  const now = options.now ?? (() => Date.now())
  const urls = options.urls ?? getCeloRpcFallbackUrls()
  const factory = options.clientFactory ?? ((url) => createCeloPublicClient({ url }))

  const endpoints: EndpointState[] = urls.map((url) => ({
    url,
    client: factory(url),
    consecutiveFailures: 0,
    skipUntilMs: null,
  }))

  function isSkipped(e: EndpointState): boolean {
    if (e.skipUntilMs == null) return false
    if (now() >= e.skipUntilMs) {
      e.skipUntilMs = null
      e.consecutiveFailures = 0
      return false
    }
    return true
  }

  function recordFailure(e: EndpointState): void {
    e.consecutiveFailures += 1
    if (e.consecutiveFailures >= SKIP_AFTER_FAILURES) {
      e.skipUntilMs = now() + SKIP_DURATION_MS
      log.warn(
        `endpoint skipped for ${SKIP_DURATION_MS}ms after ${e.consecutiveFailures} consecutive failures: ${e.url}`,
      )
    }
  }

  function recordSuccess(e: EndpointState): void {
    e.consecutiveFailures = 0
    e.skipUntilMs = null
  }

  return {
    async withFallback(label, invoke) {
      const errors: Array<{ url: string; error: string }> = []
      for (const e of endpoints) {
        if (isSkipped(e)) {
          celoRpcEndpointUsedTotal
            .labels({ provider: providerNameFromUrl(e.url), outcome: 'skip' })
            .inc()
          continue
        }
        const provider = providerNameFromUrl(e.url)
        try {
          // Sentry span per endpoint attempt. Nested spans (e.g. the viem
          // http transport internals) attach as children automatically.
          const result = await Sentry.startSpan(
            {
              name: `rpc.${label}`,
              op: 'http.client',
              attributes: {
                provider,
                url: e.url,
                method: label,
              },
            },
            () => invoke(e.client),
          )
          recordSuccess(e)
          celoRpcEndpointUsedTotal
            .labels({ provider, outcome: 'ok' })
            .inc()
          return result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          errors.push({ url: e.url, error: message })
          recordFailure(e)
          celoRpcEndpointUsedTotal
            .labels({ provider, outcome: 'error' })
            .inc()
          log.warn(`RPC ${label} failed on ${e.url}: ${message} - falling back`)
        }
      }
      const summary = errors.map((x) => `${x.url}: ${x.error}`).join(' | ')
      throw new Error(`all RPC endpoints failed for ${label} - ${summary}`)
    },
    getSkippedEndpoints() {
      return endpoints
        .filter((e) => e.skipUntilMs != null)
        .map((e) => ({ url: e.url, skipUntilMs: e.skipUntilMs as number }))
    },
  }
}

// Process-wide singleton so every consumer (the tick worker AND every
// per-address backfill loop) shares ONE endpoint skip state. Without this
// each backfill creates a fresh executor whose alchemy/forno counters
// start at zero, so 43+ concurrent backfills each pay the "3 initial
// failures then skip" cost independently, measured in prod on
// 2026-08-08 (deploy 70352169) as ~130 wasted alchemy roundtrips over
// 60s of boot burst. Sharing the executor collapses that to a single
// skip cycle per endpoint chain-wide.
let sharedExecutor: FallbackExecutor | null = null

export function getSharedCeloFallbackExecutor(): FallbackExecutor {
  if (!sharedExecutor) sharedExecutor = createCeloFallbackExecutor()
  return sharedExecutor
}

export function _resetSharedCeloFallbackExecutorForTests(): void {
  sharedExecutor = null
}
