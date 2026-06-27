import { Router, type Request, type Response } from 'express'
import { getDb } from '../lib/db'
import { HEX_ADDRESS_RE } from '../lib/hex'
import { createLogger } from '../lib/logger'
import {
  getPositions as getAllbridgePositions,
  getShortcuts as getAllbridgeShortcuts,
  triggerClaimRewards as allbridgeTriggerClaimRewards,
  triggerDeposit as allbridgeTriggerDeposit,
  triggerWithdraw as allbridgeTriggerWithdraw,
} from '../apps/allbridge'
import { APP_ID as ALLBRIDGE_APP_ID } from '../apps/allbridge/manifest'
import { createNeeruRpc, type NeeruIndexerRpcClient } from '../neeru-indexer/rpc'
import { hooksApiConfigured } from './config'
import {
  getNeeruEarnPositions,
  getNeeruHeldPositions,
} from './neeru/positions'
import { NEERU_APP_ID, getNeeruShortcuts } from './neeru/shortcuts'
import {
  buildDepositTxs,
  buildWithdrawAmountOnlyTxs,
  buildWithdrawTxs,
} from './neeru/trigger'
import type {
  EarnPosition,
  NetworkId,
  Position,
  ShortcutDefinition,
} from './neeru/types'

const router = Router()
const log = createLogger('routes:hooks-api')

const SUPPORTED_NETWORKS: ReadonlySet<NetworkId> = new Set(['celo-mainnet'])

// Lazy: tests don't need the real RPC client. We construct on first use
// so the module is import-safe even without network access.
let rpcClient: NeeruIndexerRpcClient | null = null

function getRpc(): NeeruIndexerRpcClient {
  if (!rpcClient) rpcClient = createNeeruRpc()
  return rpcClient
}

export function _setNeeruRpcForTests(client: NeeruIndexerRpcClient | null): void {
  rpcClient = client
}

function asArray(raw: unknown): string[] {
  if (raw === undefined) return []
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string')
  }
  if (typeof raw === 'string') return [raw]
  return []
}

function parseNetworkIds(raw: unknown): NetworkId[] | null {
  const list = asArray(raw)
  if (list.length === 0) return null
  const out: NetworkId[] = []
  for (const v of list) {
    if (!SUPPORTED_NETWORKS.has(v as NetworkId)) {
      return null
    }
    out.push(v as NetworkId)
  }
  return out
}

function validateAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (!HEX_ADDRESS_RE.test(raw)) return null
  return raw.toLowerCase()
}

router.get('/hooks-api/getPositions', async (req: Request, res: Response) => {
  const address = validateAddress(req.query.address)
  if (!address) {
    return res.status(400).json({ error: 'invalid address' })
  }

  const networkIdsRaw = req.query.networkIds
  const networkIds =
    networkIdsRaw === undefined
      ? (['celo-mainnet'] as NetworkId[])
      : parseNetworkIds(networkIdsRaw)
  if (networkIds === null) {
    return res.status(400).json({ error: 'invalid networkIds' })
  }

  const db = getDb()
  // Neeru requires a database; Allbridge does not. Mirror the project
  // pattern (transactions feed) that 503s when DB is not configured AND
  // the route's primary source depends on it. Here we soft-fail Neeru
  // and still try Allbridge so the wallet keeps working in dev without
  // a Postgres.
  const out: Position[] = []

  if (networkIds.includes('celo-mainnet')) {
    try {
      const allbridge = await getAllbridgePositions({
        networkId: 'celo-mainnet',
        address,
      })
      out.push(...allbridge)
    } catch (err) {
      log.warn(
        `allbridge getPositions failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (db && hooksApiConfigured() && networkIds.includes('celo-mainnet')) {
    try {
      const neeru = await getNeeruHeldPositions({
        address,
        db,
        rpc: getRpc(),
      })
      out.push(...neeru)
    } catch (err) {
      log.warn(
        `neeru getHeldPositions failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  res.json({ data: out })
})

router.get(
  '/hooks-api/getEarnPositions',
  async (req: Request, res: Response) => {
    let address: string | undefined
    if (req.query.address !== undefined) {
      const validated = validateAddress(req.query.address)
      if (!validated) {
        return res.status(400).json({ error: 'invalid address' })
      }
      address = validated
    }

    const networkIdsRaw = req.query.networkIds
    const networkIds =
      networkIdsRaw === undefined
        ? null
        : parseNetworkIds(networkIdsRaw)
    if (networkIdsRaw !== undefined && networkIds === null) {
      return res.status(400).json({ error: 'invalid networkIds' })
    }

    const supportedAppIds = asArray(req.query.supportedAppIds)
    const supportedPools = asArray(req.query.supportedPools)

    const wantAllbridge =
      supportedAppIds.length === 0 ||
      supportedAppIds.includes(ALLBRIDGE_APP_ID)
    const wantNeeru =
      supportedAppIds.length === 0 || supportedAppIds.includes(NEERU_APP_ID)

    const includeCelo = !networkIds || networkIds.includes('celo-mainnet')

    const out: EarnPosition[] = []

    if (wantAllbridge && includeCelo) {
      try {
        const allbridge = await getAllbridgePositions({
          networkId: 'celo-mainnet',
          address,
        })
        // Allbridge returns AppTokenPosition + ContractPosition; the
        // EarnPositions surface only emits the app-token entries.
        for (const p of allbridge) {
          if (p.type === 'app-token') out.push(p as EarnPosition)
        }
      } catch (err) {
        log.warn(
          `allbridge getPositions (earn) failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (wantNeeru && includeCelo && hooksApiConfigured()) {
      const db = getDb()
      if (!db) {
        log.warn(
          'neeru getEarnPositions skipped: DATABASE_URL not configured',
        )
      } else {
        try {
          const neeru = await getNeeruEarnPositions({
            address,
            db,
            rpc: getRpc(),
          })
          out.push(...neeru)
        } catch (err) {
          log.warn(
            `neeru getEarnPositions failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }

    const filtered =
      supportedPools.length === 0
        ? out
        : out.filter((p) => supportedPools.includes(p.positionId))

    res.json({ data: filtered })
  },
)

router.get(
  '/hooks-api/v2/getShortcuts',
  async (req: Request, res: Response) => {
    const networkIdsRaw = req.query.networkIds
    const networkIds =
      networkIdsRaw === undefined
        ? null
        : parseNetworkIds(networkIdsRaw)
    if (networkIdsRaw !== undefined && networkIds === null) {
      return res.status(400).json({ error: 'invalid networkIds' })
    }

    const all: ShortcutDefinition[] = [
      ...getAllbridgeShortcuts(),
      ...getNeeruShortcuts(),
    ]

    const filtered =
      networkIds === null
        ? all
        : all.filter((s) =>
            s.networkIds.some((n) => networkIds.includes(n)),
          )

    res.json({ data: filtered })
  },
)

// Error codes the trigger builders throw. When one of these surfaces it
// is the wallet's fault (invalid input, stale UI state) and we map to a
// 400. Anything else is treated as an upstream / infra failure and the
// underlying message is logged but never echoed.
const TRIGGER_USER_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_CATEGORY',
  'INVALID_AMOUNT',
  'DEPOSITS_PAUSED',
  'GLOBAL_CAP_EXCEEDED',
  'CATEGORY_CAP_EXCEEDED',
  'RATE_NOT_SET',
  'AMOUNT_BELOW_MIN',
  'POSITION_NOT_FOUND',
  'POSITION_NOT_OWNED',
  'POSITION_ALREADY_CLOSED',
  'NEERU_NOT_CONFIGURED',
])

interface TriggerShortcutBody {
  address?: unknown
  appId?: unknown
  networkId?: unknown
  shortcutId?: unknown
  [key: string]: unknown
}

function isPositiveInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  )
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)
}

function isDigitString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

interface AllbridgeTokenLeg {
  amount: string
}

function isAllbridgeTokens(value: unknown): value is AllbridgeTokenLeg[] {
  if (!Array.isArray(value)) return false
  for (const t of value) {
    if (!t || typeof t !== 'object') return false
    const amount = (t as { amount?: unknown }).amount
    if (!isDecimalString(amount)) return false
  }
  return true
}

async function dispatchAllbridge(
  shortcutId: string,
  address: string,
  body: TriggerShortcutBody,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; error: string }> {
  if (shortcutId === 'deposit') {
    const positionAddress = body.positionAddress
    const tokenAddress = body.tokenAddress
    const tokenDecimals = body.tokenDecimals
    const tokens = body.tokens
    if (
      typeof positionAddress !== 'string' ||
      !HEX_ADDRESS_RE.test(positionAddress)
    ) {
      return { ok: false, status: 400, error: 'invalid positionAddress' }
    }
    if (typeof tokenAddress !== 'string' || !HEX_ADDRESS_RE.test(tokenAddress)) {
      return { ok: false, status: 400, error: 'invalid tokenAddress' }
    }
    if (!isPositiveInt(tokenDecimals)) {
      return { ok: false, status: 400, error: 'invalid tokenDecimals' }
    }
    if (!isAllbridgeTokens(tokens)) {
      return { ok: false, status: 400, error: 'invalid tokens' }
    }
    const result = await allbridgeTriggerDeposit({
      address,
      networkId: 'celo-mainnet',
      positionAddress,
      tokenAddress,
      tokenDecimals,
      tokens,
    })
    return { ok: true, payload: result }
  }
  if (shortcutId === 'withdraw') {
    const positionAddress = body.positionAddress
    const tokenDecimals = body.tokenDecimals
    const tokens = body.tokens
    if (
      typeof positionAddress !== 'string' ||
      !HEX_ADDRESS_RE.test(positionAddress)
    ) {
      return { ok: false, status: 400, error: 'invalid positionAddress' }
    }
    if (!isPositiveInt(tokenDecimals)) {
      return { ok: false, status: 400, error: 'invalid tokenDecimals' }
    }
    if (!isAllbridgeTokens(tokens)) {
      return { ok: false, status: 400, error: 'invalid tokens' }
    }
    const result = await allbridgeTriggerWithdraw({
      address,
      networkId: 'celo-mainnet',
      positionAddress,
      tokenDecimals,
      tokens,
    })
    return { ok: true, payload: result }
  }
  if (shortcutId === 'claim-rewards') {
    const positionAddress = body.positionAddress
    if (
      typeof positionAddress !== 'string' ||
      !HEX_ADDRESS_RE.test(positionAddress)
    ) {
      return { ok: false, status: 400, error: 'invalid positionAddress' }
    }
    const result = await allbridgeTriggerClaimRewards({
      address,
      networkId: 'celo-mainnet',
      positionAddress,
    })
    return { ok: true, payload: result }
  }
  return { ok: false, status: 400, error: 'unknown shortcut' }
}

async function dispatchNeeru(
  shortcutId: string,
  address: string,
  body: TriggerShortcutBody,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; error: string }> {
  if (!hooksApiConfigured()) {
    return { ok: false, status: 503, error: 'neeru not configured' }
  }

  if (shortcutId === 'deposit') {
    const categoryId = body.categoryId
    const tokens = body.tokens
    if (!isPositiveInt(categoryId)) {
      return { ok: false, status: 400, error: 'invalid categoryId' }
    }
    if (
      !Array.isArray(tokens) ||
      tokens.length !== 1 ||
      !tokens[0] ||
      typeof tokens[0] !== 'object'
    ) {
      return { ok: false, status: 400, error: 'invalid tokens' }
    }
    const first = tokens[0] as { amount?: unknown; tokenId?: unknown }
    if (!isDigitString(first.amount)) {
      return { ok: false, status: 400, error: 'invalid tokens' }
    }
    const result = await buildDepositTxs({
      address,
      categoryId,
      amount: first.amount,
      rpc: getRpc(),
    })
    return { ok: true, payload: result }
  }

  if (shortcutId === 'withdraw' || shortcutId === 'withdraw-amount-only') {
    const positionId = body.positionId
    if (!isDigitString(positionId)) {
      return { ok: false, status: 400, error: 'invalid positionId' }
    }
    const db = getDb()
    if (!db) {
      return { ok: false, status: 503, error: 'database not configured' }
    }
    const result =
      shortcutId === 'withdraw'
        ? await buildWithdrawTxs({
            address,
            positionId,
            rpc: getRpc(),
            db,
          })
        : await buildWithdrawAmountOnlyTxs({
            address,
            positionId,
            rpc: getRpc(),
            db,
          })
    return { ok: true, payload: result }
  }

  return { ok: false, status: 400, error: 'unknown shortcut' }
}

router.post('/hooks-api/triggerShortcut', async (req, res) => {
  const body = (req.body ?? {}) as TriggerShortcutBody

  const address = validateAddress(body.address)
  if (!address) {
    return res.status(400).json({ error: 'invalid address' })
  }

  if (body.networkId !== 'celo-mainnet') {
    return res.status(400).json({ error: 'unsupported networkId' })
  }

  if (typeof body.shortcutId !== 'string' || body.shortcutId.length === 0) {
    return res.status(400).json({ error: 'invalid shortcutId' })
  }
  const shortcutId = body.shortcutId

  if (body.appId !== ALLBRIDGE_APP_ID && body.appId !== NEERU_APP_ID) {
    return res.status(400).json({ error: 'unknown appId' })
  }
  const appId = body.appId

  try {
    const dispatched =
      appId === ALLBRIDGE_APP_ID
        ? await dispatchAllbridge(shortcutId, address, body)
        : await dispatchNeeru(shortcutId, address, body)

    if (!dispatched.ok) {
      return res.status(dispatched.status).json({ error: dispatched.error })
    }

    const payload = dispatched.payload as {
      transactions: unknown[]
      dataProps?: Record<string, unknown>
    }
    return res.json({
      data: {
        transactions: payload.transactions,
        dataProps: payload.dataProps ?? {},
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (TRIGGER_USER_ERROR_CODES.has(message)) {
      return res.status(400).json({ error: message })
    }
    log.warn(`triggerShortcut failed appId=${String(appId)} shortcutId=${shortcutId}: ${message}`)
    return res.status(502).json({ error: 'shortcut build failed' })
  }
})

export { router as hooksApiRouter }
