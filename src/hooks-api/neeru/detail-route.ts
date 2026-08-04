import type { Request, Response, Router } from 'express'
import { getDb } from '../../lib/db'
import { HEX_ADDRESS_LOWER_RE } from '../../lib/hex'
import { createLogger } from '../../lib/logger'
import {
  _setSharedNeeruRpcForTests,
  getSharedNeeruRpc,
  type NeeruIndexerRpcClient,
} from '../../neeru-indexer/rpc'
import { hooksApiConfigured } from '../config'
import { getNeeruPositionDetail } from './detail'

const log = createLogger('routes:hooks-api:neeru-detail')

const ALLOWED_QUERY_PARAMS: ReadonlySet<string> = new Set(['address'])

// Delegates to the process-wide shared rpc singleton so warmup + all Neeru
// routes share ONE client (see getSharedNeeruRpc in neeru-indexer/rpc.ts).
export function _setNeeruDetailRpcForTests(
  client: NeeruIndexerRpcClient | null,
): void {
  _setSharedNeeruRpcForTests(client)
}

export function mountNeeruDetailRoute(router: Router): void {
  router.get(
    '/api/earn/neeru/positions',
    async (req: Request, res: Response) => {
      // Canonical message; do not echo the attacker-supplied key name in
      // the response (mirrors the swap-quote handler's pattern).
      for (const key of Object.keys(req.query)) {
        if (!ALLOWED_QUERY_PARAMS.has(key)) {
          return res.status(400).json({ error: 'unknown param' })
        }
      }

      const raw = req.query.address
      if (typeof raw !== 'string' || !HEX_ADDRESS_LOWER_RE.test(raw)) {
        return res.status(400).json({ error: 'invalid address' })
      }
      const address = raw

      const db = getDb()
      if (!db) {
        return res.status(503).json({ error: 'database not configured' })
      }
      if (!hooksApiConfigured()) {
        return res.status(503).json({ error: 'neeru not configured' })
      }

      try {
        const data = await getNeeruPositionDetail({
          address,
          db,
          rpc: getSharedNeeruRpc(),
        })
        return res.json({ data })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`detail fetch failed address=${address}: ${message}`)
        return res.status(502).json({ error: 'detail fetch failed' })
      }
    },
  )
}
