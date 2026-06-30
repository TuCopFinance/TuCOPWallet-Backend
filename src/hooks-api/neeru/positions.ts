import type { Pool } from 'pg'
import { CONTRACT_ADDRESS } from '../../neeru-indexer/abi'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import { decimalString } from '../../lib/decimal'
import { createLogger } from '../../lib/logger'
import {
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
const RAY = 1e27
const CATEGORIES = [0, 1, 2, 3] as const
type Category = (typeof CATEGORIES)[number]

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

let catalogueCache: CatalogueSnapshot | null = null

export function _resetHooksApiNeeruCacheForTests(): void {
  catalogueCache = null
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

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function dailyYieldPercent(rateRaw: bigint): number {
  return round6((Number(rateRaw) / RAY - 1) * 100)
}

function monthlyYieldPercent(dailyPercent: number): number {
  return round6(((dailyPercent / 100 + 1) ** 30 - 1) * 100)
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

  type AnyCall = {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }
  const catCalls: AnyCall[] = CATEGORIES.map((c) => ({
    address: CONTRACT_ADDRESS,
    abi: HOOKS_READ_ABI as unknown as readonly unknown[],
    functionName: 'categories',
    args: [c] as const,
  }))
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

  const calls = [...catCalls, ...tokenCalls]
  const results = (await deps.rpc.multicall({
    contracts: calls as unknown as Parameters<
      NeeruIndexerRpcClient['multicall']
    >[0]['contracts'],
    allowFailure: false,
  })) as unknown as readonly unknown[]

  const categories: CategoryRead[] = []
  for (let i = 0; i < CATEGORIES.length; i++) {
    const raw = results[i] as readonly unknown[]
    categories.push({
      r0: BigInt(raw[0] as bigint | number | string),
      r1: BigInt(raw[1] as bigint | number | string),
      r2: BigInt(raw[2] as bigint | number | string),
      r3: BigInt(raw[3] as bigint | number | string),
    })
  }
  const decimals = Number(results[CATEGORIES.length] as number | bigint)
  const symbol = String(results[CATEGORIES.length + 1] as string)

  catalogueCache = {
    fetchedAtMs: now(),
    categories,
    token: { decimals, symbol },
  }
  return catalogueCache
}

interface UserAggregate {
  // sum of amount (from DB) per category
  amount: Map<Category, bigint>
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
            amount::text AS amount
       FROM neeru_positions
      WHERE user_address = $1
        AND closed = FALSE`,
    [address.toLowerCase()],
  )

  const amount = new Map<Category, bigint>()
  const openIdsByCategory = new Map<Category, bigint[]>()
  for (const c of CATEGORIES) {
    amount.set(c, 0n)
    openIdsByCategory.set(c, [])
  }
  for (const row of rows) {
    const cat = row.category as Category
    if (cat !== 0 && cat !== 1 && cat !== 2 && cat !== 3) continue
    const amountBn = BigInt(row.amount)
    amount.set(cat, (amount.get(cat) ?? 0n) + amountBn)
    openIdsByCategory.get(cat)!.push(BigInt(row.position_id))
  }
  return { amount, openIdsByCategory }
}

async function fetchAccruedInterest(
  rpc: NeeruIndexerRpcClient,
  aggregate: UserAggregate,
): Promise<Map<Category, bigint>> {
  const accrued = new Map<Category, bigint>()
  for (const c of CATEGORIES) accrued.set(c, 0n)

  type AnyCall = {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }
  const flat: { category: Category; id: bigint }[] = []
  for (const c of CATEGORIES) {
    for (const id of aggregate.openIdsByCategory.get(c) ?? []) {
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
}

function buildEarnPosition(args: BuildArgs): EarnPosition {
  const { category, snapshot } = args
  const category = snapshot.categories[category]!
  const decimals = snapshot.token.decimals
  const symbol = snapshot.token.symbol

  const title = categoryTitle(category.r1)
  const dailyPct = dailyYieldPercent(category.r0)
  const monthlyPct = monthlyYieldPercent(dailyPct)
  const balance = decimalString(args.balanceWei, decimals)
  const tvl = decimalString(category.r2, decimals)
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
        priceUsd: '0',
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
    priceUsd: '0',
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

  const snapshot = await fetchCatalogue({ rpc: args.rpc, now: args.now })

  const balances = new Map<Category, bigint>()
  for (const c of CATEGORIES) balances.set(c, 0n)

  if (args.address) {
    const aggregate = await loadOpenRows(args.db, args.address)
    const accrued = await fetchAccruedInterest(args.rpc, aggregate)
    for (const c of CATEGORIES) {
      const amount = aggregate.amount.get(c) ?? 0n
      const interest = accrued.get(c) ?? 0n
      balances.set(c, amount + interest)
    }
  }

  return CATEGORIES.map((c) =>
    buildEarnPosition({
      category: c,
      snapshot,
      balanceWei: balances.get(c) ?? 0n,
    }),
  )
}

export async function getNeeruHeldPositions(
  args: GetNeeruPositionsArgs & { address: string },
): Promise<EarnPosition[]> {
  const all = await getNeeruEarnPositions(args)
  return all.filter((p) => p.balance !== '0')
}
