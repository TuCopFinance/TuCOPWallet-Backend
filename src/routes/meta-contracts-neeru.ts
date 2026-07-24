import { Router, Request, Response } from 'express'
import { env } from '../lib/env'
import { REVERT_SELECTORS } from '../hooks-api/neeru/trigger'

const router = Router()

// GET /api/meta/contracts/neeru
//
// Machine-readable contract metadata for the Neeru integration. The wallet
// consumes this to stop hardcoding partner-contract identifiers locally:
// contract address, Deposit event topic0 + data layout, custom-error
// selector map, and a semantic version tag. When any of these change on
// chain (proxy upgrade, event signature change, new custom error) ops
// updates Railway env and the wallet picks it up on next fetch without a
// wallet release.
//
// Zero-exposure: all fields ship the same info the wallet already infers
// from bytecode / receipts, or that ops has to know anyway to run the
// service. No new surface is exposed beyond what a bytecode observer +
// chain history already reveal.
//
// Cached client-side via Cache-Control since values change O(months) at
// most; a stale response for 5 min during a proxy upgrade window is
// acceptable and avoids a stampede on the metadata route.
router.get('/api/meta/contracts/neeru', (_req: Request, res: Response) => {
  const proxyAddress = env.NEERU_CONTRACT_ADDRESS ?? null
  const depositTopic0 = env.NEERU_DEPOSIT_EVENT_TOPIC0 ?? null
  const version = env.NEERU_CONTRACT_VERSION ?? null

  // Data schema for the Deposit event's non-indexed args, positional to
  // match viem's decodeAbiParameters. Field names are intentionally
  // omitted (opaque per r0..rN convention) so the wallet consumes the
  // types-only shape. Order matches the deployed event; wallet has the
  // same shape hardcoded today via the corrected NEERU_DEPOSIT_TOPIC0.
  const depositDataSchema: ReadonlyArray<{ type: string }> = [
    { type: 'uint8' },
    { type: 'uint256' },
    { type: 'uint256' },
  ]

  const events =
    depositTopic0 !== null
      ? {
          Deposit: {
            topic0: depositTopic0,
            dataSchema: depositDataSchema,
          },
        }
      : {}

  const errorSelectors: Record<string, string> = {}
  for (const [selector, reason] of Object.entries(REVERT_SELECTORS)) {
    if (reason !== 'UNKNOWN') {
      errorSelectors[reason] = selector
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json({
    proxyAddress,
    events,
    errorSelectors,
    version,
  })
})

export default router
