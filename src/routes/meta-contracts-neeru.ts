import { Router, Request, Response } from 'express'
import { celo } from 'viem/chains'
import { env } from '../lib/env'
import { REVERT_SELECTORS } from '../hooks-api/neeru/trigger'

const router = Router()

const NETWORK_ID = 'celo-mainnet'

// GET /api/meta/contracts/neeru
//
// Runtime-fetched integration metadata: proxy address, event topic0 +
// data layout, custom-error selector map, and a free-text version tag.
// Values that change on chain (proxy upgrade, event topic bump, new
// custom error) are edited in Railway env and consumers pick them up
// on next fetch. Cached client-side via Cache-Control since the values
// move O(months) at most; a stale response for 5 min during an upgrade
// window is acceptable and avoids stampede on the metadata route.
router.get('/api/meta/contracts/neeru', (_req: Request, res: Response) => {
  const proxyAddress = env.NEERU_CONTRACT_ADDRESS ?? null
  const depositTopic0 = env.NEERU_DEPOSIT_EVENT_TOPIC0 ?? null
  const version = env.NEERU_CONTRACT_VERSION ?? null
  const depositTokenAddress = env.NEERU_DEPOSIT_TOKEN_ADDRESS ?? null

  // Types-only shape for the deposit event's non-indexed args in
  // log.data. Positional; the wallet indexes into r0..r3 by position
  // and never by name. Two indexed args live in topics[1]/topics[2]
  // and are decoded separately upstream via hexToBigInt.
  const depositDataSchema: ReadonlyArray<{ type: string }> = [
    { type: 'uint8' },
    { type: 'uint256' },
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

  // Deposit token is exposed as pure config (address + chain identifiers)
  // so the wallet can drop its hardcoded copy. Decimals + symbol move
  // through the on-chain /api/earn/neeru/catalogue endpoint since those
  // require an RPC read; keeping the meta payload sync + fast is worth
  // splitting the two.
  const depositToken =
    depositTokenAddress !== null
      ? {
          address: depositTokenAddress,
          chainId: celo.id,
          networkId: NETWORK_ID,
        }
      : null

  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json({
    proxyAddress,
    events,
    errorSelectors,
    depositToken,
    version,
  })
})

export default router
