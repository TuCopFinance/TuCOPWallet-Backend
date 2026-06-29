import type { Pool } from 'pg'
import {
  CONTRACT_ADDRESS,
  READ_ABI as INDEXER_READ_ABI,
} from '../../neeru-indexer/abi'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import { getIndexerState } from '../../neeru-indexer/state'
import { createLogger } from '../../lib/logger'
import {
  EARLY_CLAIM_PENALTY_BPS_FN_ABI,
  ERC20_READ_ABI,
  PREVIEW_ACCRUED_INTEREST_FN_ABI,
  TRANCHES_FN_ABI,
} from '../neeru-abi'
import { NEERU_DEPOSIT_TOKEN_ADDRESS } from '../config'

const log = createLogger('hooks-api:neeru:detail')

const SECONDS_PER_DAY = 86_400
const RAY_NUMBER = 1e27
const CACHE_TTL_MS = 30_000
const BPS_DENOM = 10_000n

interface MulticallContract {
  address: `0x${string}`
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
}

type MulticallResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown }

interface OpenRow {
  position_id: string
  category: number
  amount: string
  start_ts: string
  end_ts: string
  deposit_block: string
  deposit_tx_hash: string
}

export interface CurrentPayoutIfClosed {
  principal: string
  interest: string
  penaltyBps: number
  interestAfterPenalty: string
  total: string
  isEarly: boolean
}

export interface NeeruPositionDetail {
  positionId: string
  tranche: number
  trancheLabel: string
  principal: string
  accruedInterest: string
  monthlyRatePercentage: number
  startTs: number
  endTs: number
  depositBlock: number
  depositTxHash: string
  renewedFromPositionId: string | null
  currentPayoutIfClosed: CurrentPayoutIfClosed
}

export interface NeeruDetailResponse {
  address: string
  positions: NeeruPositionDetail[]
  lastSyncedBlock: number | null
  lastSyncedAt: string | null
}

interface PenaltyCacheEntry {
  fetchedAtMs: number
  bps: number
}

interface SecsCacheEntry {
  fetchedAtMs: number
  secs: bigint
}

interface DecimalsCacheEntry {
  fetchedAtMs: number
  decimals: number
}

let penaltyCache: PenaltyCacheEntry | null = null
const secsCache: Map<number, SecsCacheEntry> = new Map()
let decimalsCache: DecimalsCacheEntry | null = null

export function _resetHooksApiNeeruDetailCacheForTests(): void {
  penaltyCache = null
  secsCache.clear()
  decimalsCache = null
}

function decimalString(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()
  const negative = value < 0n
  const abs = negative ? -value : value
  const asStr = abs.toString().padStart(decimals + 1, '0')
  const whole = asStr.slice(0, asStr.length - decimals)
  const frac = asStr.slice(asStr.length - decimals).replace(/0+$/, '')
  const out = frac.length === 0 ? whole : `${whole}.${frac}`
  return negative ? `-${out}` : out
}

function trancheLabel(secs: bigint): string {
  if (secs === 0n) return 'Flexible'
  const days = Number(secs) / SECONDS_PER_DAY
  return `${days} dias`
}

function monthlyRatePercentage(rateRaw: bigint): number {
  const daily = Number(rateRaw) / RAY_NUMBER
  return (daily ** 30 - 1) * 100
}

export interface GetNeeruPositionDetailArgs {
  address: string
  db: Pool
  rpc: NeeruIndexerRpcClient
  now?: () => number
  nowSeconds?: () => number
}

export async function getNeeruPositionDetail(
  args: GetNeeruPositionDetailArgs,
): Promise<NeeruDetailResponse> {
  const now = args.now ?? (() => Date.now())
  const nowSeconds =
    args.nowSeconds ?? (() => Math.floor((args.now ?? Date.now)() / 1000))
  const address = args.address.toLowerCase()

  const { rows } = await args.db.query<OpenRow>(
    `SELECT position_id::text AS position_id,
            category,
            amount::text AS amount,
            start_ts::text AS start_ts,
            end_ts::text AS end_ts,
            deposit_block::text AS deposit_block,
            deposit_tx_hash
       FROM neeru_positions
      WHERE user_address = $1
        AND closed = FALSE
      ORDER BY position_id ASC`,
    [address],
  )

  const state = await getIndexerState(args.db)
  const lastSyncedBlock = state ? Number(state.lastScannedBlock) : null
  const lastSyncedAt =
    state && state.lastScanAt ? new Date(state.lastScanAt).toISOString() : null

  if (rows.length === 0) {
    return {
      address,
      positions: [],
      lastSyncedBlock,
      lastSyncedAt,
    }
  }

  const distinctCategories = new Set<number>()
  for (const row of rows) {
    if (row.category === 0 || row.category === 1 || row.category === 2 || row.category === 3) {
      distinctCategories.add(row.category)
    }
  }

  // Build the batched multicall. Order:
  const uncachedCategories: number[] = []
  for (const c of distinctCategories) {
    const cached = secsCache.get(c)
    if (!cached || now() - cached.fetchedAtMs >= CACHE_TTL_MS) {
      uncachedCategories.push(c)
    }
  }

  const penaltyCached =
    penaltyCache && now() - penaltyCache.fetchedAtMs < CACHE_TTL_MS
  const decimalsCached =
    decimalsCache && now() - decimalsCache.fetchedAtMs < CACHE_TTL_MS

  const calls: MulticallContract[] = []

  const accruedRange: [number, number] = [calls.length, calls.length + rows.length]
  for (const row of rows) {
    calls.push({
      address: CONTRACT_ADDRESS,
      abi: [PREVIEW_ACCRUED_INTEREST_FN_ABI] as unknown as readonly unknown[],
      functionName: 'previewAccruedInterest',
      args: [BigInt(row.position_id)] as const,
    })
  }

  const tranchesRange: [number, number] = [
    calls.length,
    calls.length + uncachedCategories.length,
  ]
  for (const c of uncachedCategories) {
    calls.push({
      address: CONTRACT_ADDRESS,
      abi: [TRANCHES_FN_ABI] as unknown as readonly unknown[],
      functionName: 'tranches',
      args: [c] as const,
    })
  }

  const positionsRange: [number, number] = [
    calls.length,
    calls.length + rows.length,
  ]
  for (const row of rows) {
    calls.push({
      address: CONTRACT_ADDRESS,
      abi: INDEXER_READ_ABI as unknown as readonly unknown[],
      functionName: 'positions',
      args: [BigInt(row.position_id)] as const,
    })
  }

  let penaltyIdx: number | null = null
  if (!penaltyCached) {
    penaltyIdx = calls.length
    calls.push({
      address: CONTRACT_ADDRESS,
      abi: [EARLY_CLAIM_PENALTY_BPS_FN_ABI] as unknown as readonly unknown[],
      functionName: 'earlyClaimPenaltyBps',
      args: [] as const,
    })
  }

  let decimalsIdx: number | null = null
  if (!decimalsCached) {
    decimalsIdx = calls.length
    calls.push({
      address: NEERU_DEPOSIT_TOKEN_ADDRESS,
      abi: ERC20_READ_ABI as unknown as readonly unknown[],
      functionName: 'decimals',
      args: [] as const,
    })
  }

  const results = (await args.rpc.multicall({
    contracts: calls as unknown as Parameters<
      NeeruIndexerRpcClient['multicall']
    >[0]['contracts'],
    allowFailure: true,
  })) as ReadonlyArray<MulticallResult>

  // Fold cached + fresh tranches into a single lookup.
  const secsByCategory = new Map<number, bigint>()
  for (const c of distinctCategories) {
    const cached = secsCache.get(c)
    if (cached && now() - cached.fetchedAtMs < CACHE_TTL_MS) {
      secsByCategory.set(c, cached.secs)
    }
  }
  for (let i = 0; i < uncachedCategories.length; i++) {
    const c = uncachedCategories[i]!
    const r = results[tranchesRange[0] + i]
    if (!r || r.status !== 'success') {
      log.warn(`tranches(${c}) read failed - defaulting to 0`)
      secsByCategory.set(c, 0n)
      continue
    }
    const tuple = r.result as readonly unknown[]
    const secs = BigInt(tuple[1] as bigint | number | string)
    secsCache.set(c, { fetchedAtMs: now(), secs })
    secsByCategory.set(c, secs)
  }

  let penaltyBps: number
  if (penaltyCached && penaltyCache) {
    penaltyBps = penaltyCache.bps
  } else if (penaltyIdx !== null) {
    const r = results[penaltyIdx]
    if (r && r.status === 'success') {
      penaltyBps = Number(BigInt(r.result as bigint | number | string))
      penaltyCache = { fetchedAtMs: now(), bps: penaltyBps }
    } else {
      log.warn('earlyClaimPenaltyBps read failed - defaulting to 0')
      penaltyBps = 0
    }
  } else {
    penaltyBps = 0
  }

  // `decimals` MUST come from the live token or a fresh cache. Defaulting to
  // 18 silently misformatted payouts by orders of magnitude if the deposit
  // token used a different scale; fail-loud now so callers return 502 instead
  // of returning wrong numbers to the wallet.
  let decimals: number
  if (decimalsCached && decimalsCache) {
    decimals = decimalsCache.decimals
  } else if (decimalsIdx !== null) {
    const r = results[decimalsIdx]
    if (!r || r.status !== 'success') {
      throw new Error('erc20.decimals read failed - refusing to format payouts')
    }
    decimals = Number(r.result as number | bigint)
    decimalsCache = { fetchedAtMs: now(), decimals }
  } else {
    throw new Error(
      'erc20.decimals missing from call results - indexer config inconsistency',
    )
  }

  // ERC20.decimals is a uint8 (range 0-255), but real tokens are 6-18. An
  // upgradable contract returning a wildly out-of-range value (or a non-
  // numeric type that Number() coerces to NaN) would propagate through
  // decimalString and produce wrong user-facing numbers. Reject anything
  // outside a sane range so the route 502s instead of returning garbage.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(
      `erc20.decimals returned an out-of-range value (${decimals}); refusing to format payouts`,
    )
  }

  const positions: NeeruPositionDetail[] = []
  const tsNow = nowSeconds()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const accruedR = results[accruedRange[0] + i]
    const positionsR = results[positionsRange[0] + i]

    const accruedWei =
      accruedR && accruedR.status === 'success'
        ? BigInt(accruedR.result as bigint | number | string)
        : 0n

    let rateRaw = 0n
    if (positionsR && positionsR.status === 'success') {
      const tuple = positionsR.result as readonly unknown[]
      rateRaw = BigInt(tuple[7] as bigint | number | string)
    } else {
      log.warn(
        `positions(${row.position_id}) read failed - monthly rate defaulting to 0`,
      )
    }

    const principalWei = BigInt(row.amount)
    const principalStr = decimalString(principalWei, decimals)
    const accruedStr = decimalString(accruedWei, decimals)
    const secs = secsByCategory.get(row.category) ?? 0n
    const endTs = Number(row.end_ts)
    const isEarly = row.category !== 0 && tsNow < endTs

    let interestAfterPenaltyWei: bigint
    if (isEarly && penaltyBps > 0) {
      const factor = BPS_DENOM - BigInt(penaltyBps)
      interestAfterPenaltyWei = (accruedWei * factor) / BPS_DENOM
    } else {
      interestAfterPenaltyWei = accruedWei
    }
    const totalWei = principalWei + interestAfterPenaltyWei

    positions.push({
      positionId: row.position_id,
      tranche: row.category,
      trancheLabel: trancheLabel(secs),
      principal: principalStr,
      accruedInterest: accruedStr,
      monthlyRatePercentage: monthlyRatePercentage(rateRaw),
      startTs: Number(row.start_ts),
      endTs,
      depositBlock: Number(row.deposit_block),
      depositTxHash: row.deposit_tx_hash,
      renewedFromPositionId: null,
      currentPayoutIfClosed: {
        principal: principalStr,
        interest: accruedStr,
        penaltyBps,
        interestAfterPenalty: decimalString(interestAfterPenaltyWei, decimals),
        total: decimalString(totalWei, decimals),
        isEarly,
      },
    })
  }

  return {
    address,
    positions,
    lastSyncedBlock,
    lastSyncedAt,
  }
}
