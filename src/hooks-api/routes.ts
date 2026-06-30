import { Router, type Request, type Response } from 'express'
import { getDb } from '../lib/db'
import { HEX_ADDRESS_RE } from '../lib/hex'
import { createLogger } from '../lib/logger'
import {
  getPositions as getAllbridgePositions,
  getShortcuts as getAllbridgeShortcuts,
} from '../apps/allbridge'
import { APP_ID as ALLBRIDGE_APP_ID } from '../apps/allbridge/manifest'
import { createNeeruRpc, type NeeruIndexerRpcClient } from '../neeru-indexer/rpc'
import { hooksApiConfigured } from './config'
import { mountNeeruDetailRoute } from './neeru/detail-route'
import {
  getNeeruEarnPositions,
  getNeeruHeldPositions,
} from './neeru/positions'
import { NEERU_APP_ID, getNeeruShortcuts } from './neeru/shortcuts'
import { dispatchAllbridge } from './trigger/allbridge'
import { dispatchNeeru } from './trigger/neeru'
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
  // a Postgres. Partial failures are flagged in `meta.partialFailure` so
  // the wallet can distinguish "no positions" from "indexer/api down".
  const out: Position[] = []
  const partialFailure: { allbridge?: boolean; neeru?: boolean } = {}

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
      partialFailure.allbridge = true
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
      partialFailure.neeru = true
    }
  }

  const body: { data: Position[]; meta?: { partialFailure: typeof partialFailure } } = {
    data: out,
  }
  if (partialFailure.allbridge || partialFailure.neeru) {
    body.meta = { partialFailure }
  }
  res.json(body)
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
    const partialFailure: { allbridge?: boolean; neeru?: boolean } = {}

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
        partialFailure.allbridge = true
      }
    }

    if (wantNeeru && includeCelo && hooksApiConfigured()) {
      const db = getDb()
      if (!db) {
        log.warn(
          'neeru getEarnPositions skipped: DATABASE_URL not configured',
        )
        partialFailure.neeru = true
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
          partialFailure.neeru = true
        }
      }
    }

    const filtered =
      supportedPools.length === 0
        ? out
        : out.filter((p) => supportedPools.includes(p.positionId))

    const body: {
      data: EarnPosition[]
      meta?: { partialFailure: typeof partialFailure }
    } = { data: filtered }
    if (partialFailure.allbridge || partialFailure.neeru) {
      body.meta = { partialFailure }
    }
    res.json(body)
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
  'INVALID_TRANCHE',
  'INVALID_AMOUNT',
  'DEPOSITS_PAUSED',
  'GLOBAL_CAP_EXCEEDED',
  'TRANCHE_CAP_EXCEEDED',
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
        : await dispatchNeeru(shortcutId, address, body, { rpc: getRpc() })

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

mountNeeruDetailRoute(router)

export { router as hooksApiRouter }
