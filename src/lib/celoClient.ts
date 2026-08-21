import {
  createPublicClient,
  fallback,
  http,
  type PublicClient,
  type Transport,
} from 'viem'
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

// Optional. Returns undefined when ALCHEMY_RPC_URL is not set (older deploys
// or dev machines without an Alchemy key). Callers must handle absence.
export function getAlchemyRpcUrl(): string | undefined {
  return env.ALCHEMY_RPC_URL
}

// Public Node's aggregated Celo RPC. Free, no key, generous rate limits
// (confirmed 2026-08-15: 20 concurrent eth_getTransactionReceipt fetches
// all succeeded, 100-block eth_getLogs with address filter returned 55
// events). Added to the fallback chain as the go-to backup when Alchemy
// hits its 25 CU/s compute-unit cap. Optional so the deploy tolerates a
// dead-DNS transient by simply skipping this position.
export function getPublicnodeRpcUrl(): string | undefined {
  return env.PUBLICNODE_RPC_URL
}

// Blockscout's RPC-compat endpoint. Indexer-backed (not a node), which
// means it has archive-level data availability: confirmed 2026-08-15 to
// return `eth_getTransactionReceipt` results for txs that forno + drpc +
// celocolombia all drop. Critical insurance for the tx-indexer receipt-
// fetch path.
export function getBlockscoutRpcUrl(): string | undefined {
  return env.BLOCKSCOUT_RPC_URL
}

// Thirdweb's public Celo RPC. Free, no key, works for baseline reads
// (getBlockNumber verified 2026-08-15). Another cheap position in the
// fallback chain that runs on a different backbone from the others.
export function getThirdwebRpcUrl(): string | undefined {
  return env.THIRDWEB_RPC_URL
}

// Extra ad-hoc RPC URLs, comma-separated. Escape hatch for adding new
// providers without a code change when the ecosystem shifts.
// Deduplicated + trimmed before being appended to the chain.
export function getExtraRpcUrls(): readonly string[] {
  const raw = env.EXTRA_CELO_RPC_URLS
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
}

// Canonical fallback chain for Celo public-client reads.
//
// Order rationale (2026-08-16 revision after live measurement):
//
// Publicnode is FIRST because it has no visible rate limit under a
// 20-concurrent stress test and consistently returned every receipt we
// asked for. Putting it in front lets the tick loops absorb their burst
// there instead of hammering Alchemy's 25 CU/s free-tier cap on the
// initial boot burst (observed 2026-08-15 - a fresh container flooded
// Alchemy into a 5-min skip window within seconds of coming up, then
// cascaded through everything else which was still cold, stalling the
// tick until Alchemy came back).
//
// Alchemy is SECOND (still favored over the anonymous public
// endpoints because we own the key). When publicnode absent it becomes
// first by natural fallthrough.
//
// Order (best-first, 2026-08-16):
//   1. Publicnode - free, unlimited-ish, no per-second cap observed.
//   2. Alchemy - dedicated endpoint, own key, own quota (25 CU/s cap).
//   3. Forno - canonical public Celo endpoint.
//   4. Blockscout eth-rpc - indexer-backed, ARCHIVE receipts (returns
//      txs that node-based providers drop). Slower per-call but critical
//      for the tx-indexer soft-skip-avoidance path.
//   5. Thirdweb - free public backup on a different backbone.
//   6. Ankr - rate-limited around 10 req/s on free tier.
//   7. DRPC - public endpoint does NOT support eth_getTransactionReceipt
//      (JSON-RPC error `does not exist`), but still serves other methods.
//   8. Primary (rpc.celocolombia.org) - kept last after 2026-08-03 silent
//      degradation. See memory `rpc_fallback_silent_degradation.md`.
//   9. Any `EXTRA_CELO_RPC_URLS` (comma-separated) - appended at the
//      tail so operators can rotate new providers in without a deploy.
//
// Both the Neeru indexer (custom skip-after-failure supervisor) and the
// transactions-indexer / Allbridge route (viem's fallback transport)
// consume this list. Single source of truth - do NOT redefine in other
// modules.
export function getCeloRpcFallbackUrls(): readonly string[] {
  const publicnode = getPublicnodeRpcUrl()
  const alchemy = getAlchemyRpcUrl()
  const blockscoutRpc = getBlockscoutRpcUrl()
  const thirdweb = getThirdwebRpcUrl()
  const urls: string[] = []
  if (publicnode) urls.push(publicnode)
  if (alchemy) urls.push(alchemy)
  urls.push(getFornoUrl())
  if (blockscoutRpc) urls.push(blockscoutRpc)
  if (thirdweb) urls.push(thirdweb)
  urls.push(getAnkrRpcUrl())
  urls.push(getDrpcRpcUrl())
  urls.push(getPrimaryRpcUrl())
  for (const extra of getExtraRpcUrls()) urls.push(extra)
  // Dedupe in case someone accidentally sets two envs to the same URL.
  return Array.from(new Set(urls))
}

// Cached singleton client wired with viem's built-in `fallback` transport
// across the full RPC chain (`getCeloRpcFallbackUrls()`). Every read
// automatically fails over to the next endpoint on RPC error, so hot-path
// handlers (tx-status, positions-notify, tx-indexer routes, /ready probe)
// stay alive when Forno pegs Cloudflare 1015 or Alchemy hits its 25 CU/s
// cap. Uses the shared chain order so a Railway env addition propagates
// uniformly.
//
// viem's fallback lacks the custom skip-window semantics that
// `getSharedCeloFallbackExecutor()` layers on top; that stays the choice
// for tight-loop consumers (indexer tick, backfill) where a persistently
// dead endpoint would otherwise be retried on every call. For sporadic
// request-time reads, viem's per-call fallover is enough.
let cachedSharedClient: PublicClient | null = null

export function getSharedCeloClient(): PublicClient {
  if (!cachedSharedClient) {
    const urls = getCeloRpcFallbackUrls()
    const transports = urls.map((u) => http(u))
    cachedSharedClient = createPublicClient({
      chain: celo,
      transport: fallback(transports),
    }) as unknown as PublicClient
  }
  return cachedSharedClient
}

// Cached singleton client bound to Forno only. Kept for the narrow set of
// consumers that specifically need a single-URL client (e.g. WRI relay
// paths that already carry their own fallback wrapper around the wallet
// client). Prefer `getSharedCeloClient()` for new call sites.
let cachedClient: PublicClient | null = null

export function getCeloPublicClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createCeloPublicClient({ url: getFornoUrl() })
  }
  return cachedClient
}

export function _resetCeloClientForTests(): void {
  cachedClient = null
  cachedSharedClient = null
}
