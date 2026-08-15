// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Token prices
// proxy" documents the wire shape + Statsig gate wallet-side. Any change to
// response fields here must land alongside a diff to that section in the
// same PR.
//
// GET /api/tokens/info?networkIds=celo-mainnet
// Drop-in replacement for Valora's legacy /getTokensInfoWithPrices endpoint
// (api.mainnet.valora.xyz), which stopped returning priceUsd for any token
// on 2026-08-14 leaving all TuCop users with "precio no disponible" for
// non-XAUt tokens.
//
// Response shape mirrors what the wallet parses in src/tokens/saga.ts
// (StoredTokenBalance): { [tokenId]: { address, decimals, symbol, name,
// networkId, tokenId, priceUsd?, priceFetchedAt?, isFeeCurrency?, ... } }.
//
// Prices come from the multi-provider waterfall in src/lib/priceProviders.ts:
// CoinMarketCap -> CoinGecko -> DIA -> Mento (COPm only) -> hardcoded 1.0
// for USD-pegged. Cached in Redis for CACHE_TTL_SECONDS per networkIds slug.

import { Router, Request, Response } from 'express'
import { createLogger } from '../lib/logger'
import {
  fetchTokenPrices,
  type PriceSymbol,
  type ProviderName,
} from '../lib/priceProviders'
import { buildCacheKey } from '../lib/query'
import { getRedis } from '../lib/redis'
import { Sentry } from '../lib/sentry'

const UPSTREAM_PROVIDERS: readonly ProviderName[] = ['dia', 'coingecko', 'cmc']

const router = Router()
const log = createLogger('routes:tokens')

// Short TTL: wallet refetches on balance changes anyway; keep fresh price
// but avoid hammering upstream providers on cold cache. 30s aligns with
// CoinGecko's own `cache-control: max-age=30`.
const CACHE_TTL_SECONDS = 30

// Which network slugs the endpoint serves. Today only celo-mainnet. New
// networks add here + a per-network token catalogue below.
const SUPPORTED_NETWORK_IDS = new Set(['celo-mainnet'])

// Wallet's ALLOWED_TOKEN_IDS pin. Each entry is one row of the response
// keyed by `${networkId}:${address}` (lowercase). Metadata mirrors what the
// wallet consumes (see StoredTokenBalance interface in wallet's slice.ts).
// We only serve the 6 tokens the wallet allow-lists; anything else the
// wallet already filters out client-side.
interface TokenCatalogueEntry {
  address: `0x${string}` | 'native'
  decimals: number
  symbol: string
  name: string
  networkId: string
  isCoreToken?: boolean
  isFeeCurrency?: boolean
  isSwappable?: boolean
  isStableCoin?: boolean
  isCashInEligible?: boolean
  isCashOutEligible?: boolean
  showZeroBalance?: boolean
  imageUrl?: string
  feeCurrencyAdapterAddress?: string
  feeCurrencyAdapterDecimals?: number
  minimumAppVersionToSwap?: string
  priceSymbol: PriceSymbol // key into the priceProviders module
}

// Address casing: wallet's tokenId is `${networkId}:${lowercase_address}`.
// Symbol values preserve the current Valora quirks (USD₮ unicode, cCOP
// legacy) so the wallet doesn't see a shape drift on switchover. Legacy
// names can be normalized later coordinated with the wallet team.
const CELO_MAINNET_TOKENS: TokenCatalogueEntry[] = [
  {
    address: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
    decimals: 6,
    symbol: 'USD₮', // "USD₮" with the unicode T that Valora returns
    name: 'Tether USD',
    networkId: 'celo-mainnet',
    isCoreToken: true,
    isFeeCurrency: true,
    isStableCoin: true,
    isSwappable: true,
    isCashInEligible: true,
    isCashOutEligible: true,
    imageUrl: 'https://raw.githubusercontent.com/valora-inc/address-metadata/main/assets/tokens/USDT.png',
    feeCurrencyAdapterAddress: '0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72',
    feeCurrencyAdapterDecimals: 6,
    priceSymbol: 'USDT',
  },
  {
    address: '0xceba9300f2b948710d2653dd7b07f33a8b32118c',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
    networkId: 'celo-mainnet',
    isCoreToken: true,
    isFeeCurrency: true,
    isStableCoin: true,
    isSwappable: true,
    isCashInEligible: true,
    isCashOutEligible: true,
    imageUrl: 'https://raw.githubusercontent.com/valora-inc/address-metadata/main/assets/tokens/USDC.png',
    feeCurrencyAdapterAddress: '0x2f25deb3848c207fc8e0c34035b3ba7fc157602b',
    feeCurrencyAdapterDecimals: 6,
    priceSymbol: 'USDC',
  },
  {
    address: '0x765de816845861e75a25fca122bb6898b8b1282a',
    decimals: 18,
    symbol: 'cUSD',
    name: 'Celo Dollar',
    networkId: 'celo-mainnet',
    isCoreToken: true,
    isFeeCurrency: true,
    isStableCoin: true,
    isSwappable: true,
    isCashInEligible: true,
    isCashOutEligible: true,
    imageUrl: 'https://raw.githubusercontent.com/valora-inc/address-metadata/main/assets/tokens/cUSD.png',
    priceSymbol: 'USDm',
  },
  {
    address: '0x8a567e2ae79ca692bd748ab832081c45de4041ea',
    decimals: 18,
    symbol: 'cCOP',
    name: 'Celo Colombian Peso',
    networkId: 'celo-mainnet',
    isCoreToken: true,
    isStableCoin: true,
    isSwappable: true,
    isCashInEligible: true,
    isCashOutEligible: true,
    imageUrl: 'https://raw.githubusercontent.com/valora-inc/address-metadata/main/assets/tokens/cCOP.png',
    priceSymbol: 'COPm',
  },
  {
    address: '0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff',
    decimals: 6,
    symbol: 'XAUt0',
    name: 'Tether Gold',
    networkId: 'celo-mainnet',
    isCoreToken: true,
    isSwappable: true,
    isCashInEligible: false,
    isCashOutEligible: false,
    imageUrl: 'https://raw.githubusercontent.com/valora-inc/address-metadata/main/assets/tokens/XAUt0.png',
    priceSymbol: 'XAUt',
  },
  {
    address: '0xa2036f0538221a77a3937f1379699f44945018d0',
    decimals: 6,
    symbol: 'USAT',
    name: 'Anchorage Digital USAT',
    networkId: 'celo-mainnet',
    isStableCoin: true,
    isSwappable: false,
    priceSymbol: 'USAT',
  },
]

interface ResponseEntry {
  address: string
  decimals: number
  imageUrl?: string
  name: string
  symbol: string
  networkId: string
  tokenId: string
  priceUsd?: string
  priceFetchedAt?: number
  isFeeCurrency?: boolean
  isNative?: boolean
  isStableCoin?: boolean
  isSwappable?: boolean
  showZeroBalance?: boolean
  isCoreToken?: boolean
  isCashInEligible?: boolean
  isCashOutEligible?: boolean
  feeCurrencyAdapterAddress?: string
  feeCurrencyAdapterDecimals?: number
  minimumAppVersionToSwap?: string
}

// Whether a token catalogue entry is served for a given network id.
function tokensForNetwork(networkId: string): TokenCatalogueEntry[] {
  if (networkId === 'celo-mainnet') return CELO_MAINNET_TOKENS
  return []
}

router.get('/api/tokens/info', async (req: Request, res: Response) => {
  const networkIdsParam = req.query.networkIds
  if (typeof networkIdsParam !== 'string' || networkIdsParam.length === 0) {
    return res.status(400).json({ error: 'missing networkIds' })
  }
  const requested = networkIdsParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const unknown = requested.filter((id) => !SUPPORTED_NETWORK_IDS.has(id))
  if (unknown.length > 0) {
    return res.status(400).json({ error: 'unsupported networkId' })
  }

  const cacheKey = buildCacheKey('tokens', req.path, {
    networkIds: requested.slice().sort().join(','),
  })
  const cache = getRedis()
  try {
    const cached = await cache?.get(cacheKey)
    if (cached) {
      return res.json(JSON.parse(cached))
    }
  } catch (err) {
    log.warn('redis read failed:', err instanceof Error ? err.message : err)
  }

  const tokens = requested.flatMap(tokensForNetwork)
  const wantedSymbols = Array.from(
    new Set(tokens.map((t) => t.priceSymbol)),
  ) as PriceSymbol[]

  let fetchResult: Awaited<ReturnType<typeof fetchTokenPrices>>
  try {
    fetchResult = await fetchTokenPrices(wantedSymbols)
  } catch (err) {
    log.warn(
      'price waterfall unexpectedly threw:',
      err instanceof Error ? err.message : err,
    )
    fetchResult = { prices: new Map(), usedProviders: [], skippedProviders: [] }
  }

  const body: Record<string, ResponseEntry> = {}
  const providerCount: Partial<Record<ProviderName, number>> = {}
  for (const t of tokens) {
    const addressForKey = t.address === 'native' ? '0x0' : t.address
    const tokenId = `${t.networkId}:${addressForKey.toLowerCase()}`
    const entry: ResponseEntry = {
      address: t.address === 'native' ? '0x0' : t.address,
      decimals: t.decimals,
      symbol: t.symbol,
      name: t.name,
      networkId: t.networkId,
      tokenId,
    }
    if (t.imageUrl) entry.imageUrl = t.imageUrl
    if (t.isFeeCurrency !== undefined) entry.isFeeCurrency = t.isFeeCurrency
    if (t.isStableCoin !== undefined) entry.isStableCoin = t.isStableCoin
    if (t.isSwappable !== undefined) entry.isSwappable = t.isSwappable
    if (t.showZeroBalance !== undefined) entry.showZeroBalance = t.showZeroBalance
    if (t.isCoreToken !== undefined) entry.isCoreToken = t.isCoreToken
    if (t.isCashInEligible !== undefined) entry.isCashInEligible = t.isCashInEligible
    if (t.isCashOutEligible !== undefined) entry.isCashOutEligible = t.isCashOutEligible
    if (t.feeCurrencyAdapterAddress) entry.feeCurrencyAdapterAddress = t.feeCurrencyAdapterAddress
    if (t.feeCurrencyAdapterDecimals !== undefined) {
      entry.feeCurrencyAdapterDecimals = t.feeCurrencyAdapterDecimals
    }
    if (t.minimumAppVersionToSwap) entry.minimumAppVersionToSwap = t.minimumAppVersionToSwap

    const priceRow = fetchResult.prices.get(t.priceSymbol)
    if (priceRow) {
      // priceUsd is a string in the wallet contract (StoredTokenBalance.priceUsd: string).
      // Preserve full precision from the provider without JS Number coercion loss.
      entry.priceUsd = priceRow.priceUsd.toString()
      entry.priceFetchedAt = priceRow.fetchedAtMs
      providerCount[priceRow.source] = (providerCount[priceRow.source] ?? 0) + 1
    }
    body[tokenId] = entry
  }

  const unresolvedSymbols = wantedSymbols.filter(
    (s) => !fetchResult.prices.has(s),
  )
  const allUpstreamSkipped = UPSTREAM_PROVIDERS.every((p) =>
    fetchResult.skippedProviders.includes(p),
  )

  // Audit log for observability. When the endpoint degrades to a lower tier
  // provider (or misses tokens entirely), the dashboard should reflect it
  // via this signal. Mirrors the swap_quote_comparison log convention.
  log.warn(
    JSON.stringify({
      event: 'tokens_info_served',
      networkIds: requested,
      tokenCount: tokens.length,
      pricedCount: Object.values(body).filter((e) => e.priceUsd).length,
      providersUsed: fetchResult.usedProviders,
      providersSkipped: fetchResult.skippedProviders,
      perProvider: providerCount,
      unresolvedSymbols,
    }),
  )

  if (allUpstreamSkipped) {
    Sentry.captureMessage('tokens_info_all_upstream_providers_skipped', {
      level: 'warning',
      tags: {
        event: 'tokens_info_all_upstream_providers_skipped',
        networkIds: requested.join(','),
      },
      extra: {
        providersSkipped: fetchResult.skippedProviders,
        providersUsed: fetchResult.usedProviders,
        perProvider: providerCount,
      },
    })
  }
  if (unresolvedSymbols.length > 0) {
    Sentry.captureMessage('tokens_info_unresolved_symbols', {
      level: 'warning',
      tags: {
        event: 'tokens_info_unresolved_symbols',
        networkIds: requested.join(','),
      },
      extra: {
        unresolvedSymbols,
        providersUsed: fetchResult.usedProviders,
        providersSkipped: fetchResult.skippedProviders,
      },
    })
  }

  try {
    await cache?.set(cacheKey, JSON.stringify(body), 'EX', CACHE_TTL_SECONDS)
  } catch (err) {
    log.warn('redis write failed:', err instanceof Error ? err.message : err)
  }
  res.json(body)
})

export default router
