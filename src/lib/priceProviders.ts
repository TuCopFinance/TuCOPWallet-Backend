// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Token prices"
// documents the /api/tokens/info endpoint that consumes this module.
//
// Multi-provider price fetch with waterfall fallback. Each provider carries
// its own quota / rate-limit envelope; when one exhausts, we skip it for a
// cool-down window and cascade to the next. Same pattern as
// src/lib/celoRpcFallback.ts (RPC endpoints), proven in production for the
// Neeru indexer since #19.
//
// Provider chain (ordered by "always up first, keep paid quota in reserve"):
//   1. DIA Data (public, no key, no quota, ~500ms per-token parallel)
//   2. CoinGecko Demo (our key, 30 req/min, 10k/mo free, single batch call)
//   3. CoinMarketCap Pro (our paid key, monthly credit quota, single batch)
//   4. Mento SortedOracles (on-chain, only COPm, no quota)
//   5. Hardcoded 1.0 (only USD-pegged: USDT/USDC/USDm/USAT)
//
// Rationale for DIA-first: at CACHE_TTL_SECONDS=30 the endpoint fires
// ~2 fetches/min in steady state (~86k/month). If DIA handles 99.9% of
// those, we never consume CoinGecko or CMC quota in normal operation and
// keep them fully reserved for real outages. Trade-off is +200-500ms
// latency on cache-miss requests (DIA per-token parallel vs. one CMC
// batch call), but every cache-hit request is under 5ms so the overall
// user-facing latency is dominated by hit rate, not miss cost.
//
// Each provider entry knows how to identify a quota-exhausted response vs a
// transient error, so we skip long on exhaustion and short on flakes. Same
// skip semantics as celoRpcFallback: SKIP_AFTER_FAILURES consecutive fails
// -> skip for SKIP_DURATION_MS. Exhaustion signals bump the skip window to
// EXHAUSTED_SKIP_MS so we don't hammer a dead provider hourly.

import { fetchWithTimeout } from './http'
import { createLogger } from './logger'
import { priceProviderTierUsedTotal } from './metrics'
import { Sentry } from './sentry'

const log = createLogger('lib:price-providers')

const SKIP_AFTER_FAILURES = 3
const SKIP_DURATION_MS = 5 * 60 * 1000 // 5 min for transient
const EXHAUSTED_SKIP_MS = 60 * 60 * 1000 // 1 hour when quota is exhausted

// Symbols the wallet actually consumes. Anything outside this list is
// returned without priceUsd from the endpoint (the wallet already has
// hardcoded fallbacks for unknown tokens).
export type PriceSymbol = 'USDT' | 'USDC' | 'USDm' | 'COPm' | 'XAUt' | 'USAT' | 'CELO'

// Per-symbol mapping to the ids/addresses each provider understands.
// Kept as a single source of truth so a new provider only wires the
// fetch function; symbol -> provider-id lookup lives here.
interface SymbolProviderIds {
  cmcSymbol?: string // e.g. 'USDT' for CoinMarketCap /quotes/latest?symbol=
  coingeckoId?: string // e.g. 'tether' for CoinGecko /simple/price?ids=
  diaBlockchain?: string // e.g. 'Celo' for DIA /v1/assetQuotation/{chain}/{addr}
  diaAddress?: string // 0x... on the DIA chain
  mento?: true // enable Mento SortedOracles path (COPm only)
  hardcodedUsd?: number // last-resort fallback (only for stable pegs)
}

const SYMBOL_TABLE: Record<PriceSymbol, SymbolProviderIds> = {
  USDT: {
    cmcSymbol: 'USDT',
    coingeckoId: 'tether',
    diaBlockchain: 'Celo',
    diaAddress: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    hardcodedUsd: 1.0,
  },
  USDC: {
    cmcSymbol: 'USDC',
    coingeckoId: 'usd-coin',
    diaBlockchain: 'Celo',
    diaAddress: '0xceBA9300f2b948710d2653dD7B07f33A8B32118C',
    hardcodedUsd: 1.0,
  },
  USDm: {
    // USDm is the Mento re-branded cUSD. CMC and CoinGecko both index it
    // under the historical cUSD identifier (celo-dollar / CUSD symbol).
    cmcSymbol: 'CUSD',
    coingeckoId: 'celo-dollar',
    diaBlockchain: 'Celo',
    diaAddress: '0x765DE816845861e75A25fCA122bb6898B8B1282a',
    hardcodedUsd: 1.0,
  },
  COPm: {
    // Same rebrand story as USDm: CMC and CoinGecko still index as cCOP.
    cmcSymbol: 'CCOP',
    coingeckoId: 'ccop',
    diaBlockchain: 'Celo',
    diaAddress: '0x8A567e2aE79CA692Bd748aB832081C45de4041eA',
    mento: true,
    // NO hardcoded: COPm is COP-pegged, not USD-pegged; fabricating 1.0 USD
    // for COPm would be a 3000x error the wallet would show to users.
  },
  XAUt: {
    cmcSymbol: 'XAUT',
    coingeckoId: 'tether-gold',
    diaBlockchain: 'Ethereum',
    diaAddress: '0x68749665FF8D2d112Fa859AA293F07A622782F38',
    // NO hardcoded: gold price fluctuates; the wallet must show an error
    // rather than a stale 1.0 fabricated value.
  },
  USAT: {
    // USAT is not indexed by CMC / CoinGecko / DIA. Anchorage Digital
    // stablecoin, 1:1 USD pegged by design (100% T-bills + cash). The
    // wallet has hardcoded fallback = 1.0 for this and we mirror it.
    hardcodedUsd: 1.0,
  },
  CELO: {
    cmcSymbol: 'CELO',
    coingeckoId: 'celo',
    diaBlockchain: 'Celo',
    diaAddress: '0x471EcE3750Da237f93B8E339c536989b8978a438',
    // NO hardcoded: CELO price fluctuates; missing priceUsd is preferable to
    // fabricating a stale value the wallet would display as "Pagada en CELO ~$X".
  },
}

export type ProviderName = 'cmc' | 'coingecko' | 'dia' | 'mento' | 'hardcoded'

interface ProviderState {
  consecutiveFailures: number
  skipUntilMs: number | null
}

interface FetchResult {
  priceUsd: number
  source: ProviderName
  fetchedAtMs: number
}

// A provider fetch function returns either a Map of prices (may be empty
// or partial), throws for a transient error, or throws an ExhaustionError
// for quota-exhausted responses. The controller handles the state changes.
export class ProviderExhaustedError extends Error {
  constructor(providerName: ProviderName, upstreamMessage: string) {
    super(`provider ${providerName} exhausted: ${upstreamMessage}`)
    this.name = 'ProviderExhaustedError'
  }
}

// Batch fetch functions per provider. Each receives the full list of
// symbols the caller wants and returns whatever it managed to price
// (partial OK; missing symbols fall through to the next provider).
type ProviderBatchFetch = (
  symbols: readonly PriceSymbol[],
  now: () => number,
) => Promise<Map<PriceSymbol, number>>

interface Provider {
  name: ProviderName
  fetch: ProviderBatchFetch
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

// CoinMarketCap Pro batch quotes. Handles the "credit limit exceeded" error
// (code 1010) as ProviderExhaustedError so the controller can skip us long.
const cmcBatchFetch: ProviderBatchFetch = async (symbols) => {
  // Read process.env directly (rather than via the zod-frozen env proxy) so
  // tests can flip the value at runtime; zod validated the key at boot.
  const key = process.env.COINMARKETCAP_API_KEY
  if (!key) throw new Error('COINMARKETCAP_API_KEY not set')
  const cmcSymbols = symbols
    .map((s) => SYMBOL_TABLE[s].cmcSymbol)
    .filter((v): v is string => !!v)
  if (cmcSymbols.length === 0) return new Map()

  const url = new URL('https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest')
  url.searchParams.set('symbol', cmcSymbols.join(','))
  url.searchParams.set('convert', 'USD')
  const res = await fetchWithTimeout(url.toString(), {
    headers: { 'X-CMC_PRO_API_KEY': key },
  })
  const json = (await res.json()) as {
    status?: { error_code?: number; error_message?: string }
    data?: Record<string, unknown>
  }
  const errCode = json.status?.error_code ?? 0
  if (errCode === 1010 || errCode === 1006) {
    throw new ProviderExhaustedError('cmc', json.status?.error_message ?? 'quota exhausted')
  }
  if (!res.ok || errCode !== 0) {
    throw new Error(
      `cmc http ${res.status} code ${errCode} ${json.status?.error_message ?? ''}`,
    )
  }

  const out = new Map<PriceSymbol, number>()
  for (const symbol of symbols) {
    const cmcKey = SYMBOL_TABLE[symbol].cmcSymbol
    if (!cmcKey) continue
    const entries = (json.data ?? {})[cmcKey]
    const entry = Array.isArray(entries) ? entries[0] : entries
    const price = (entry as { quote?: { USD?: { price?: number } } } | undefined)?.quote?.USD?.price
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      out.set(symbol, price)
    }
  }
  return out
}

const coingeckoBatchFetch: ProviderBatchFetch = async (symbols) => {
  // Same test-mutation rationale as cmcBatchFetch above.
  const key = process.env.COINGECKO_API_KEY
  const ids = symbols
    .map((s) => SYMBOL_TABLE[s].coingeckoId)
    .filter((v): v is string => !!v)
  if (ids.length === 0) return new Map()

  const url = new URL('https://api.coingecko.com/api/v3/simple/price')
  url.searchParams.set('ids', ids.join(','))
  url.searchParams.set('vs_currencies', 'usd')
  const headers: Record<string, string> = {}
  if (key) headers['x-cg-demo-api-key'] = key
  const res = await fetchWithTimeout(url.toString(), { headers })
  if (res.status === 429) {
    throw new ProviderExhaustedError('coingecko', 'rate limit 429')
  }
  if (!res.ok) {
    throw new Error(`coingecko http ${res.status}`)
  }
  const json = (await res.json()) as Record<string, { usd?: number } | undefined> & {
    status?: { error_code?: number; error_message?: string }
  }
  if (json.status?.error_code === 429) {
    throw new ProviderExhaustedError('coingecko', json.status?.error_message ?? 'rate limit')
  }
  const out = new Map<PriceSymbol, number>()
  for (const symbol of symbols) {
    const id = SYMBOL_TABLE[symbol].coingeckoId
    if (!id) continue
    const price = json[id]?.usd
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      out.set(symbol, price)
    }
  }
  return out
}

const diaBatchFetch: ProviderBatchFetch = async (symbols) => {
  // DIA does not support batch, issue individual fetches in parallel and
  // consolidate. Cheap because each is a short HTTPS call to a CDN-cached
  // endpoint and we cap the whole batch under a Redis TTL upstream.
  const eligible = symbols
    .map((symbol) => {
      const t = SYMBOL_TABLE[symbol]
      return t.diaBlockchain && t.diaAddress
        ? { symbol, blockchain: t.diaBlockchain, address: t.diaAddress }
        : null
    })
    .filter((v): v is { symbol: PriceSymbol; blockchain: string; address: string } => !!v)
  if (eligible.length === 0) return new Map()

  const out = new Map<PriceSymbol, number>()
  await Promise.all(
    eligible.map(async ({ symbol, blockchain, address }) => {
      try {
        const url = `https://api.diadata.org/v1/assetQuotation/${blockchain}/${address}`
        const res = await fetchWithTimeout(url)
        if (!res.ok) return
        const j = (await res.json()) as { Price?: number }
        if (typeof j.Price === 'number' && Number.isFinite(j.Price) && j.Price > 0) {
          out.set(symbol, j.Price)
        }
      } catch (err) {
        log.warn(
          `dia fetch ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }),
  )
  return out
}

// Mento SortedOracles for COPm only. Reads medianRate(COPm) which returns
// numerator/denominator as CELO-per-COP fixed-point, then combines with
// CELO USD (from anyone in the chain that already gave us a CELO price).
// For MVP we don't yet have CELO in the wallet's ALLOWED_TOKEN_IDS, so this
// implementation queries CoinGecko unauth'd for CELO/USD as a compact
// side-channel. The controller only calls this when COPm is unresolved
// after all upper tiers, so the extra call is rare (only when 3 providers
// upstream already failed for COPm).
async function mentoCopmPriceUsd(): Promise<number | null> {
  const { createPublicClient, http, parseAbi } = await import('viem')
  const { celo } = await import('viem/chains')
  const client = createPublicClient({ chain: celo, transport: http('https://forno.celo.org') })
  const COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea' as `0x${string}`
  const ORACLE = '0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33' as `0x${string}`
  try {
    const [numerator, denominator] = (await client.readContract({
      address: ORACLE,
      abi: parseAbi([
        'function medianRate(address rateFeedID) view returns (uint256 numerator, uint256 denominator)',
      ]),
      functionName: 'medianRate',
      args: [COPM],
    })) as readonly [bigint, bigint]
    if (denominator === 0n) return null
    // medianRate returns CELO per COPm as numerator/denominator (same units).
    // COP per CELO = numerator / denominator. We need COPm USD price:
    //   priceUsd(COPm) = priceUsd(CELO) / (COP per CELO)
    const copPerCelo = Number(numerator) / Number(denominator)
    if (!Number.isFinite(copPerCelo) || copPerCelo <= 0) return null
    // Side-channel CELO/USD fetch (short-circuit if network fails):
    const cgRes = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=celo&vs_currencies=usd',
    )
    if (!cgRes.ok) return null
    const cg = (await cgRes.json()) as { celo?: { usd?: number } }
    const celoUsd = cg.celo?.usd
    if (typeof celoUsd !== 'number' || !Number.isFinite(celoUsd) || celoUsd <= 0) return null
    return celoUsd / copPerCelo
  } catch (err) {
    log.warn(
      `mento COPm derivation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

const mentoBatchFetch: ProviderBatchFetch = async (symbols) => {
  const out = new Map<PriceSymbol, number>()
  if (!symbols.includes('COPm')) return out
  const p = await mentoCopmPriceUsd()
  if (p !== null) out.set('COPm', p)
  return out
}

// Hardcoded fallback: only applies to symbols with an explicit `hardcodedUsd`
// value. Callers should treat this as "last resort" and dashboard how often
// it fires (it's a signal that all upstream sources are down).
const hardcodedBatchFetch: ProviderBatchFetch = async (symbols) => {
  const out = new Map<PriceSymbol, number>()
  for (const symbol of symbols) {
    const v = SYMBOL_TABLE[symbol].hardcodedUsd
    if (typeof v === 'number') out.set(symbol, v)
  }
  return out
}

// ---------------------------------------------------------------------------
// Controller: waterfall fallback with per-provider circuit breaker
// ---------------------------------------------------------------------------

const providerState = new Map<ProviderName, ProviderState>()

function getState(name: ProviderName): ProviderState {
  let s = providerState.get(name)
  if (!s) {
    s = { consecutiveFailures: 0, skipUntilMs: null }
    providerState.set(name, s)
  }
  return s
}

function isSkipped(name: ProviderName, now: number): boolean {
  const s = getState(name)
  if (s.skipUntilMs == null) return false
  if (now >= s.skipUntilMs) {
    s.skipUntilMs = null
    s.consecutiveFailures = 0
    return false
  }
  return true
}

function recordFailure(name: ProviderName, exhausted: boolean, now: number): void {
  const s = getState(name)
  s.consecutiveFailures += 1
  const skipMs = exhausted ? EXHAUSTED_SKIP_MS : SKIP_DURATION_MS
  if (exhausted || s.consecutiveFailures >= SKIP_AFTER_FAILURES) {
    s.skipUntilMs = now + skipMs
    log.warn(
      `provider ${name} skipped for ${skipMs}ms (exhausted=${exhausted}, consecutive=${s.consecutiveFailures})`,
    )
  }
}

function recordSuccess(name: ProviderName): void {
  const s = getState(name)
  s.consecutiveFailures = 0
  s.skipUntilMs = null
}

const PROVIDERS: readonly Provider[] = [
  { name: 'dia', fetch: diaBatchFetch },
  { name: 'coingecko', fetch: coingeckoBatchFetch },
  { name: 'cmc', fetch: cmcBatchFetch },
  { name: 'mento', fetch: mentoBatchFetch },
  { name: 'hardcoded', fetch: hardcodedBatchFetch },
]

export interface FetchPricesResult {
  prices: Map<PriceSymbol, FetchResult>
  usedProviders: ProviderName[] // in order tried
  skippedProviders: ProviderName[] // in order tried
}

// Waterfall: try each provider in order for symbols still unresolved.
// Returns a map of symbol -> { priceUsd, source, fetchedAtMs } and the list
// of providers we touched (for telemetry).
export async function fetchTokenPrices(
  wantedSymbols: readonly PriceSymbol[],
  options: { now?: () => number } = {},
): Promise<FetchPricesResult> {
  const now = options.now ?? (() => Date.now())
  const nowMs = now()
  const remaining = new Set<PriceSymbol>(wantedSymbols)
  const prices = new Map<PriceSymbol, FetchResult>()
  const used: ProviderName[] = []
  const skipped: ProviderName[] = []

  for (let i = 0; i < PROVIDERS.length; i++) {
    const provider = PROVIDERS[i]!
    const tier = String(i + 1)
    if (remaining.size === 0) break
    if (isSkipped(provider.name, nowMs)) {
      skipped.push(provider.name)
      priceProviderTierUsedTotal
        .labels({ provider: provider.name, tier, outcome: 'skip' })
        .inc(remaining.size)
      continue
    }
    const requestSymbols = Array.from(remaining)
    // Sentry span per tier so a slow tier shows up on the trace waterfall.
    // Wrapped with startSpan (callback form) so the span auto-closes on
    // resolve/reject; nested spans inside the provider fetch (if any)
    // become children automatically.
    try {
      const partial = await Sentry.startSpan(
        {
          name: `price.tier.${provider.name}`,
          op: 'http.client',
          attributes: {
            provider: provider.name,
            tier,
            symbols: requestSymbols.join(','),
            symbolCount: requestSymbols.length,
          },
        },
        () => provider.fetch(requestSymbols, now),
      )
      used.push(provider.name)
      recordSuccess(provider.name)
      priceProviderTierUsedTotal
        .labels({ provider: provider.name, tier, outcome: 'ok' })
        .inc(partial.size)
      for (const [symbol, price] of partial.entries()) {
        prices.set(symbol, {
          priceUsd: price,
          source: provider.name,
          fetchedAtMs: now(),
        })
        remaining.delete(symbol)
      }
    } catch (err) {
      const isExhausted = err instanceof ProviderExhaustedError
      recordFailure(provider.name, isExhausted, nowMs)
      priceProviderTierUsedTotal
        .labels({ provider: provider.name, tier, outcome: 'error' })
        .inc(requestSymbols.length)
      log.warn(
        `provider ${provider.name} failed (exhausted=${isExhausted}): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      )
    }
  }

  if (remaining.size > 0) {
    log.warn(
      `token prices unresolved after all providers: ${Array.from(remaining).join(',')}`,
    )
  }
  return { prices, usedProviders: used, skippedProviders: skipped }
}

// Convenience for callers that only need a single symbol (e.g. XAUT, Neeru
// COPm valuation). Uses the full waterfall internally.
export async function fetchSingleTokenPrice(
  symbol: PriceSymbol,
): Promise<FetchResult | null> {
  const r = await fetchTokenPrices([symbol])
  return r.prices.get(symbol) ?? null
}

// Test-only: reset all provider state (skip windows, failure counters).
export function _resetProviderStateForTests(): void {
  providerState.clear()
}
