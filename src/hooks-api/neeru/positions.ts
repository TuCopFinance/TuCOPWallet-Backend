import type { Pool } from 'pg'
import { CONTRACT_ADDRESS } from '../../neeru-indexer/abi'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import { decimalString } from '../../lib/decimal'
import { createLogger } from '../../lib/logger'
import { fetchSingleTokenPrice } from '../../lib/priceProviders'
import {
  CATEGORY_COUNT_FN_ABI,
  ERC20_READ_ABI,
  HOOKS_READ_ABI,
  PREVIEW_ACCRUED_INTEREST_FN_ABI,
} from '../neeru-abi'
import {
  NEERU_CONTRACT_CREATED_AT_ISO,
  NEERU_DEPOSIT_TOKEN_ADDRESS,
  NEERU_MANAGE_URL,
  NEERU_TERMS_URL,
  hooksApiConfigured,
  categoryImageUrl,
} from '../config'
import { NEERU_APP_ID } from './shortcuts'
import type { EarnPosition, NetworkId } from './types'

const log = createLogger('hooks-api:neeru:positions')

const NETWORK_ID: NetworkId = 'celo-mainnet'
const APP_NAME = 'Neeru Vaults'
const SECONDS_PER_DAY = 86_400
const RAY = 10n ** 27n
// Category ids are discovered at runtime from the on-chain TRANCHE_COUNT()
// view function rather than being hardcoded. The type is intentionally
// widened to `number` because the true upper bound lives in the contract.
// See fetchCatalogue for the discovery flow and the env fallback.
type Category = number

// Guard against a corrupt or malicious TRANCHE_COUNT() return so a bad RPC
// response can not force the backend to allocate an unbounded call array.
// The cap sits well above the current set (6) with room for organic growth.
const CATEGORY_COUNT_MAX = 32

interface CategoryRead {
  r0: bigint
  r1: bigint
  r2: bigint
  r3: bigint
}

interface TokenInfo {
  decimals: number
  symbol: string
}

interface CatalogueSnapshot {
  fetchedAtMs: number
  categories: CategoryRead[]
  token: TokenInfo
}

interface OpenRow {
  position_id: string
  category: number
  amount: string
}

const CATALOGUE_TTL_MS = 30_000
// Price is cached longer than the catalogue since the COP/USD forex rate
// moves on the order of hours, not seconds. The wallet gets a stale-but-
// close estimate rather than a fresh RPC every request.
const PRICE_TTL_MS = 60_000

let catalogueCache: CatalogueSnapshot | null = null

interface PriceSnapshot {
  fetchedAtMs: number
  priceUsd: string
}
let priceCache: PriceSnapshot | null = null

export function _resetHooksApiNeeruCacheForTests(): void {
  catalogueCache = null
  priceCache = null
}

// Fetches USD price of one COPm token via the multi-provider waterfall
// (DIA -> CoinGecko -> CMC -> Mento on-chain). Fails soft to '0'
// so a total-blackout does not break the whole positions endpoint;
// wallet then shows the "$ 0.00" state that existed before this
// endpoint was priced.
async function fetchCopmPriceCached(now: () => number): Promise<string> {
  if (priceCache && now() - priceCache.fetchedAtMs < PRICE_TTL_MS) {
    return priceCache.priceUsd
  }
  try {
    const priced = await fetchSingleTokenPrice('COPm')
    if (!priced) {
      log.warn('copm price waterfall returned null - returning 0')
      return '0'
    }
    // 10 decimal places is far more precision than COP/USD moves per
    // minute; keeps the JSON compact vs full float toString.
    const asStr = priced.priceUsd.toFixed(10)
    priceCache = { fetchedAtMs: now(), priceUsd: asStr }
    return asStr
  } catch (err) {
    log.warn(
      `copm price fetch failed - returning '0': ${err instanceof Error ? err.message : String(err)}`,
    )
    return '0'
  }
}

// decimalString moved to src/lib/decimal.ts (Fase 4 PR 28). The local
// SerializedDecimalNumber type is a string alias; the imported helper
// returns a plain string so call sites still flow through the type
// system via the existing function signatures that wrap it.

function positionIdFor(category: Category): string {
  return `${NETWORK_ID}:${CONTRACT_ADDRESS.toLowerCase()}:category-${category}`
}

function depositTokenId(): string {
  return `${NETWORK_ID}:${NEERU_DEPOSIT_TOKEN_ADDRESS}`
}

function categoryTitle(secs: bigint): string {
  if (secs === 0n) return 'Flexible'
  const days = Number(secs / BigInt(SECONDS_PER_DAY))
  return `${days} dias`
}

function rpow(base: bigint, exp: number, scale: bigint): bigint {
  let result = scale
  let b = base
  let e = exp
  while (e > 0) {
    if (e & 1) result = (result * b) / scale
    b = (b * b) / scale
    e >>= 1
  }
  return result
}

function dailyYieldPercent(rateRaw: bigint): number {
  const half = RAY / 2n
  const scaled = ((rateRaw - RAY) * 100n * 1_000_000n + half) / RAY
  return Number(scaled) / 1_000_000
}

export function monthlyYieldPercent(rateRaw: bigint): number {
  const compounded = rpow(rateRaw, 30, RAY)
  const half = RAY / 2n
  const scaled = ((compounded - RAY) * 100n * 1_000_000n + half) / RAY
  return Number(scaled) / 1_000_000
}

// Colombian financial convention: quotes are monthly effective (M.V.); the
// headline shown to users is the annual effective (E.A.) so it compares
// against every other yield surface.
//
// The contract accrues by multiplying by a daily rate every day (dailyRateRay
// scaled by RAY). After 365 days the accrued factor is dailyRate^365, so
// effective annual = (1 + dailyRate)^365 - 1. Given monthlyPct is derived
// from the same dailyRate via 30-day compounding, the equivalent expression
// in monthly terms is:
//
//   E.A. = (1 + M.V./100)^(365/30) - 1
//
// This is 12.16..-power compounding, NOT the 12-power we used before
// 2026-08-18. The 12-power formula implicitly assumed monthly compounding
// (which the contract does NOT do) and under-quoted every category by
// ~0.15pp vs the on-chain accrual and vs what neerufinance.xyz publishes.
// Wallet team caught the drift 2026-08-18 during a cross-check.
export function annualEffectivePercent(monthlyPct: number): number {
  if (!Number.isFinite(monthlyPct) || monthlyPct <= 0) return 0
  const monthly = monthlyPct / 100
  const annual = (Math.pow(1 + monthly, 365 / 30) - 1) * 100
  return Number(annual.toFixed(6))
}

interface FetchCatalogueDeps {
  rpc: NeeruIndexerRpcClient
  now?: () => number
}

async function fetchCatalogue(
  deps: FetchCatalogueDeps,
): Promise<CatalogueSnapshot> {
  const now = deps.now ?? (() => Date.now())
  if (catalogueCache && now() - catalogueCache.fetchedAtMs < CATALOGUE_TTL_MS) {
    return catalogueCache
  }

  // Discover how many categories the deployed contract exposes. Reading
  // the count from the chain avoids a source-code literal that has to be
  // bumped every time governance appends a tranche. If the call reverts
  // (older impl that predates TRANCHE_COUNT) fall back to the env
  // NEERU_CATEGORY_COUNT override; without either signal we refuse to
  // serve a stale catalogue.
  const categoryCount = await resolveCategoryCount(deps.rpc)

  type AnyCall = {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }
  const categoryCalls: AnyCall[] = []
  for (let i = 0; i < categoryCount; i++) {
    categoryCalls.push({
      address: CONTRACT_ADDRESS,
      abi: HOOKS_READ_ABI as unknown as readonly unknown[],
      functionName: 'tranches',
      args: [i] as const,
    })
  }
  const tokenCalls: AnyCall[] = [
    {
      address: NEERU_DEPOSIT_TOKEN_ADDRESS,
      abi: ERC20_READ_ABI as unknown as readonly unknown[],
      functionName: 'decimals',
      args: [] as const,
    },
    {
      address: NEERU_DEPOSIT_TOKEN_ADDRESS,
      abi: ERC20_READ_ABI as unknown as readonly unknown[],
      functionName: 'symbol',
      args: [] as const,
    },
  ]

  const calls = [...categoryCalls, ...tokenCalls]
  const results = (await deps.rpc.multicall({
    contracts: calls as unknown as Parameters<
      NeeruIndexerRpcClient['multicall']
    >[0]['contracts'],
    allowFailure: false,
  })) as unknown as readonly unknown[]

  const categories: CategoryRead[] = []
  for (let i = 0; i < categoryCount; i++) {
    const raw = results[i] as readonly unknown[]
    categories.push({
      r0: BigInt(raw[0] as bigint | number | string),
      r1: BigInt(raw[1] as bigint | number | string),
      r2: BigInt(raw[2] as bigint | number | string),
      r3: BigInt(raw[3] as bigint | number | string),
    })
  }
  const decimals = Number(results[categoryCount] as number | bigint)
  const symbol = String(results[categoryCount + 1] as string)

  catalogueCache = {
    fetchedAtMs: now(),
    categories,
    token: { decimals, symbol },
  }
  return catalogueCache
}

async function resolveCategoryCount(
  rpc: NeeruIndexerRpcClient,
): Promise<number> {
  const envOverride = process.env.NEERU_CATEGORY_COUNT
  const envParsed =
    envOverride != null && envOverride !== ''
      ? Number(envOverride)
      : null

  let onChainCount: number | null = null
  try {
    const raw = (await rpc.readContract({
      address: CONTRACT_ADDRESS,
      abi: [CATEGORY_COUNT_FN_ABI] as const,
      functionName: 'TRANCHE_COUNT',
      args: [] as const,
    })) as bigint
    onChainCount = Number(raw)
  } catch (err) {
    log.warn(
      `TRANCHE_COUNT() read failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const resolved = onChainCount ?? envParsed
  if (resolved == null) {
    throw new Error(
      'category count could not be resolved: TRANCHE_COUNT() reverted and NEERU_CATEGORY_COUNT env is not set',
    )
  }
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > CATEGORY_COUNT_MAX) {
    throw new Error(
      `invalid category count ${resolved} - expected integer in [1, ${CATEGORY_COUNT_MAX}]`,
    )
  }
  return resolved
}

// Wire-shaped catalogue for the /api/earn/neeru/catalogue endpoint.
// Fields intentionally use opaque positional names (r0..r3 -> secs/rate) so
// the response documents ordering without echoing internal on-chain names.
export interface NeeruCatalogueEntry {
  id: number
  secs: string
  rateRay: string
  monthlyRatePercentage: number
  annualEffectivePercentage: number
}

export interface NeeruCatalogueSnapshot {
  categories: NeeruCatalogueEntry[]
  token: {
    address: string
    decimals: number
    symbol: string
  }
  fetchedAt: string
}

export async function getNeeruCatalogueSnapshot(
  rpc: NeeruIndexerRpcClient,
  opts?: { now?: () => number },
): Promise<NeeruCatalogueSnapshot> {
  const snapshot = await fetchCatalogue({ rpc, now: opts?.now })
  const entries: NeeruCatalogueEntry[] = snapshot.categories.map(
    (read, id) => {
      const monthly = monthlyYieldPercent(read.r0)
      return {
        id,
        secs: read.r1.toString(),
        rateRay: read.r0.toString(),
        monthlyRatePercentage: monthly,
        annualEffectivePercentage: annualEffectivePercent(monthly),
      }
    },
  )
  return {
    categories: entries,
    token: {
      address: NEERU_DEPOSIT_TOKEN_ADDRESS,
      decimals: snapshot.token.decimals,
      symbol: snapshot.token.symbol,
    },
    fetchedAt: new Date(snapshot.fetchedAtMs).toISOString(),
  }
}

interface UserAggregate {
  // sum of amount (from DB) per category
  amountByCategory: Map<Category, bigint>
  // open positionIds per category (used to fetch previewAccruedInterest)
  openIdsByCategory: Map<Category, bigint[]>
}

async function loadOpenRows(
  db: Pool,
  address: string,
): Promise<UserAggregate> {
  const { rows } = await db.query<OpenRow>(
    `SELECT position_id::text AS position_id,
            category,
            amount::text
       FROM neeru_positions
      WHERE user_address = $1
        AND closed = FALSE`,
    [address.toLowerCase()],
  )

  // Do not pre-seed the maps against a hardcoded id set: the number of
  // categories lives on-chain now, so let the DB rows drive population.
  // Callers use Map.get(id) ?? 0n which handles absent ids uniformly.
  const amountByCategory = new Map<Category, bigint>()
  const openIdsByCategory = new Map<Category, bigint[]>()
  for (const row of rows) {
    const cat = row.category
    if (!Number.isInteger(cat) || cat < 0) continue
    const amountBn = BigInt(row.amount)
    amountByCategory.set(cat, (amountByCategory.get(cat) ?? 0n) + amountBn)
    const ids = openIdsByCategory.get(cat) ?? []
    ids.push(BigInt(row.position_id))
    openIdsByCategory.set(cat, ids)
  }
  return { amountByCategory, openIdsByCategory }
}

async function fetchAccruedInterest(
  rpc: NeeruIndexerRpcClient,
  aggregate: UserAggregate,
): Promise<Map<Category, bigint>> {
  const accrued = new Map<Category, bigint>()

  type AnyCall = {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }
  const flat: { category: Category; id: bigint }[] = []
  for (const [c, ids] of aggregate.openIdsByCategory) {
    for (const id of ids) {
      flat.push({ category: c, id })
    }
  }
  if (flat.length === 0) return accrued

  const calls: AnyCall[] = flat.map((entry) => ({
    address: CONTRACT_ADDRESS,
    abi: [PREVIEW_ACCRUED_INTEREST_FN_ABI] as unknown as readonly unknown[],
    functionName: 'previewAccruedInterest',
    args: [entry.id] as const,
  }))
  const results = (await rpc.multicall({
    contracts: calls as unknown as Parameters<
      NeeruIndexerRpcClient['multicall']
    >[0]['contracts'],
    allowFailure: true,
  })) as ReadonlyArray<
    | { status: 'success'; result: bigint | number | string }
    | { status: 'failure'; error: unknown }
  >

  for (let i = 0; i < flat.length; i++) {
    const entry = flat[i]!
    const r = results[i]
    if (!r || r.status !== 'success') {
      log.warn(
        `previewAccruedInterest failed for positionId=${entry.id.toString()} category=${entry.category}`,
      )
      continue
    }
    const v = BigInt(r.result)
    accrued.set(entry.category, (accrued.get(entry.category) ?? 0n) + v)
  }
  return accrued
}

interface BuildArgs {
  category: Category
  snapshot: CatalogueSnapshot
  balanceWei: bigint
  priceUsd: string
}

function buildEarnPosition(args: BuildArgs): EarnPosition {
  const { category, snapshot } = args
  const categoryRead = snapshot.categories[category]!
  const decimals = snapshot.token.decimals
  const symbol = snapshot.token.symbol

  const title = categoryTitle(categoryRead.r1)
  const dailyPct = dailyYieldPercent(categoryRead.r0)
  const monthlyPct = monthlyYieldPercent(categoryRead.r0)
  const balance = decimalString(args.balanceWei, decimals)
  const tvl = decimalString(categoryRead.r2, decimals)
  const tokenId = depositTokenId()

  return {
    type: 'app-token',
    positionId: positionIdFor(category),
    address: CONTRACT_ADDRESS.toLowerCase(),
    networkId: NETWORK_ID,
    appId: NEERU_APP_ID,
    appName: APP_NAME,
    label: title,
    displayProps: {
      title,
      description: `Genera intereses bloqueando tus Pesos por ${title}`,
      imageUrl: categoryImageUrl(category),
      manageUrl: NEERU_MANAGE_URL,
    },
    dataProps: {
      yieldRates: [
        {
          percentage: monthlyPct,
          label: 'Tasa mensual',
          tokenId,
        },
      ],
      earningItems: [],
      depositTokenId: tokenId,
      withdrawTokenId: tokenId,
      tvl,
      termsUrl: NEERU_TERMS_URL,
      manageUrl: NEERU_MANAGE_URL,
      dailyYieldRatePercentage: dailyPct,
      contractCreatedAt: NEERU_CONTRACT_CREATED_AT_ISO ?? undefined,
      cantSeparateCompoundedInterest: false,
      safety: {
        level: 'medium',
        risks: [
          {
            isPositive: true,
            title: 'Custodia on-chain',
            category: 'custody',
          },
          {
            isPositive: false,
            title: 'Liquidez del fondo limitada',
            category: 'liquidity',
          },
        ],
      },
    },
    tokens: [
      {
        type: 'base-token',
        tokenId,
        address: NEERU_DEPOSIT_TOKEN_ADDRESS,
        networkId: NETWORK_ID,
        symbol,
        decimals,
        priceUsd: args.priceUsd,
        balance,
      },
    ],
    availableShortcutIds: ['deposit', 'withdraw'],
    shortcutTriggerArgs: {
      deposit: { categoryId: category },
      withdraw: { categoryId: category },
    },
    symbol,
    decimals,
    priceUsd: args.priceUsd,
    balance,
    supply: balance,
    pricePerShare: ['1'],
  }
}

export interface GetNeeruPositionsArgs {
  address?: string
  db: Pool
  rpc: NeeruIndexerRpcClient
  now?: () => number
}

export async function getNeeruEarnPositions(
  args: GetNeeruPositionsArgs,
): Promise<EarnPosition[]> {
  if (!hooksApiConfigured()) return []

  const now = args.now ?? (() => Date.now())
  // Snapshot + price in parallel so the price fetch does not add to
  // the request's critical path when the catalogue read is a cache hit.
  const [snapshot, priceUsd] = await Promise.all([
    fetchCatalogue({ rpc: args.rpc, now: args.now }),
    fetchCopmPriceCached(now),
  ])

  const categoryIds = snapshot.categories.map((_, i) => i)
  const balances = new Map<Category, bigint>()
  for (const c of categoryIds) balances.set(c, 0n)

  if (args.address) {
    const aggregate = await loadOpenRows(args.db, args.address)
    const accrued = await fetchAccruedInterest(args.rpc, aggregate)
    for (const c of categoryIds) {
      const amount = aggregate.amountByCategory.get(c) ?? 0n
      const interest = accrued.get(c) ?? 0n
      balances.set(c, amount + interest)
    }
  }

  return categoryIds.map((c) =>
    buildEarnPosition({
      category: c,
      snapshot,
      balanceWei: balances.get(c) ?? 0n,
      priceUsd,
    }),
  )
}

export async function getNeeruHeldPositions(
  args: GetNeeruPositionsArgs & { address: string },
): Promise<EarnPosition[]> {
  const all = await getNeeruEarnPositions(args)
  return all.filter((p) => p.balance !== '0')
}
