import { Router, Request, Response } from 'express'
import { erc20Abi } from 'viem'
import { getCeloPublicClient } from '../lib/celoClient'
import { NEERU_DEPOSIT_TOKEN_ADDRESS } from '../hooks-api/config'
import { CATEGORY_READ_FN_ABI, CONTRACT_ADDRESS } from '../neeru-indexer/abi'
import { buildProvisionalDeposit } from '../hooks-api/neeru/notify'
import { createLogger } from '../lib/logger'

const router = Router()
const log = createLogger('routes:positions-notify')

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const HASH_RE = /^0x[0-9a-fA-F]{64}$/

interface NotifyBody {
  address?: unknown
  tx?: unknown
}

// In-process caches: category window secs and deposit-token decimals move
// O(months) at most. 5-minute TTL is generous but bounds staleness for
// the operator on config changes.
const CATEGORY_SECS_TTL_MS = 5 * 60 * 1000
const DECIMALS_TTL_MS = 5 * 60 * 1000

interface CategorySecsSnapshot {
  fetchedAtMs: number
  secs: Map<number, bigint>
}
interface DecimalsSnapshot {
  fetchedAtMs: number
  decimals: number
}

let categorySecsCache: CategorySecsSnapshot | null = null
let decimalsCache: DecimalsSnapshot | null = null

export function _resetPositionsNotifyCacheForTests(): void {
  categorySecsCache = null
  decimalsCache = null
}

// POST /api/earn/neeru/positions/notify
//
// Body: { address: "0x...", tx: "0x..." }
//
// Parses the deposit receipt server-side and returns the same
// NeeruPositionDetail shape the wallet gets from
// GET /api/earn/neeru/positions plus a `provisional: true` flag. Wallet
// renders the card immediately after a successful deposit tx without
// waiting for the indexer to catch up (which typically takes 5-15s on a
// healthy tip).
//
// Once the indexer records the same positionId, subsequent GET responses
// carry the real record without the `provisional` flag; the wallet
// supersedes its optimistic copy.
router.post(
  '/api/earn/neeru/positions/notify',
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as NotifyBody
    const address = body.address
    const tx = body.tx
    if (typeof address !== 'string' || !ADDR_RE.test(address)) {
      return res.status(400).json({ error: 'invalid address' })
    }
    if (typeof tx !== 'string' || !HASH_RE.test(tx)) {
      return res.status(400).json({ error: 'invalid tx' })
    }

    const client = getCeloPublicClient()

    // Preload category window secs and deposit decimals from cache or on
    // demand. Both are cheap on-chain reads; caching keeps the notify
    // path a single receipt read on the hot path.
    let categorySecsMap: Map<number, bigint>
    try {
      categorySecsMap = await getCategorySecs(client)
    } catch (err) {
      log.warn(
        `category secs preload failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return res.status(502).json({ error: 'rpc unavailable' })
    }
    let decimals: number
    try {
      decimals = await getDepositDecimals(client)
    } catch (err) {
      log.warn(
        `decimals preload failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return res.status(502).json({ error: 'rpc unavailable' })
    }

    const outcome = await buildProvisionalDeposit({
      address,
      txHash: tx,
      client,
      categorySecs: (c) => categorySecsMap.get(c) ?? null,
      depositDecimals: decimals,
    })

    switch (outcome.kind) {
      case 'ok':
        return res.json({ data: outcome.response })
      case 'invalid_body':
        return res.status(400).json({ error: outcome.error })
      case 'not_configured':
        return res.status(503).json({ error: outcome.error })
      case 'wrong_address':
        return res.status(403).json({ error: outcome.error })
      case 'not_deposit':
        return res.status(422).json({ error: outcome.error })
      case 'not_found':
        return res.status(404).json({ error: outcome.error })
      case 'rpc_error':
        log.warn(`rpc error while notifying: ${outcome.error}`)
        return res.status(502).json({ error: 'rpc unavailable' })
    }
  },
)

async function getCategorySecs(
  client: ReturnType<typeof getCeloPublicClient>,
): Promise<Map<number, bigint>> {
  const now = Date.now()
  if (
    categorySecsCache &&
    now - categorySecsCache.fetchedAtMs < CATEGORY_SECS_TTL_MS
  ) {
    return categorySecsCache.secs
  }
  // Reuse the indexer's CATEGORY_READ_FN_ABI so the ABI stays in one
  // place. We only read output index 1 (window secs) per category.
  const results = (await client.multicall({
    contracts: [0, 1, 2, 3].map((c) => ({
      address: CONTRACT_ADDRESS,
      abi: [CATEGORY_READ_FN_ABI],
      functionName: 'tranches' as const,
      args: [c] as const,
    })),
    allowFailure: false,
  })) as unknown as ReadonlyArray<readonly [bigint, bigint, bigint, bigint]>
  const secs = new Map<number, bigint>()
  for (let i = 0; i < 4; i++) {
    const tuple = results[i]!
    secs.set(i, tuple[1])
  }
  categorySecsCache = { fetchedAtMs: now, secs }
  return secs
}

async function getDepositDecimals(
  client: ReturnType<typeof getCeloPublicClient>,
): Promise<number> {
  const now = Date.now()
  if (decimalsCache && now - decimalsCache.fetchedAtMs < DECIMALS_TTL_MS) {
    return decimalsCache.decimals
  }
  const decimals = await client.readContract({
    address: NEERU_DEPOSIT_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: 'decimals',
  })
  decimalsCache = { fetchedAtMs: now, decimals: Number(decimals) }
  return decimalsCache.decimals
}

export default router
