import { Router, Request, Response } from 'express'
import {
  _setSharedNeeruRpcForTests,
  getSharedNeeruRpc,
  type NeeruIndexerRpcClient,
} from '../neeru-indexer/rpc'
import { getNeeruCatalogueSnapshot } from '../hooks-api/neeru/positions'
import { hooksApiConfigured } from '../hooks-api/config'
import { createLogger } from '../lib/logger'

const router = Router()
const log = createLogger('routes:earn-neeru-catalogue')

// Delegates to the process-wide shared rpc singleton so warmup + all Neeru
// routes share ONE client (see getSharedNeeruRpc in neeru-indexer/rpc.ts).
export function _setEarnNeeruCatalogueRpcForTests(
  client: NeeruIndexerRpcClient | null,
): void {
  _setSharedNeeruRpcForTests(client)
}

// GET /api/earn/neeru/catalogue
//
// Runtime-fetched on-chain catalogue: category IDs with their lock windows
// (secs), raw per-second rate (rateRay), and derived monthly / annual
// effective percentages. Also exposes the deposit token's decimals + symbol
// so the wallet does not need a local token metadata table for the pool
// cards. The upstream cache in positions.ts (30s TTL) covers stampede.
//
// Consumers should treat categories as authoritative for IDs, lock periods,
// and rate values. Wallet-side hardcoded copies of these three break every
// time the operator retunes a category on chain; consuming this endpoint
// removes the need for a wallet release when that happens.
router.get(
  '/api/earn/neeru/catalogue',
  async (_req: Request, res: Response) => {
    if (!hooksApiConfigured()) {
      return res.status(503).json({ error: 'neeru not configured' })
    }
    try {
      const snapshot = await getNeeruCatalogueSnapshot(getSharedNeeruRpc())
      res.setHeader('Cache-Control', 'public, max-age=30')
      return res.json({ data: snapshot })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`catalogue fetch failed: ${message}`)
      return res.status(502).json({ error: 'catalogue fetch failed' })
    }
  },
)

export default router
