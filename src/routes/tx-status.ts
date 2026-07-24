import { Router, Request, Response } from 'express'
import type { PublicClient } from 'viem'
import { getCeloPublicClient } from '../lib/celoClient'
import { createLogger } from '../lib/logger'
import {
  REVERT_SELECTORS,
  type SimulationReason,
} from '../hooks-api/neeru/trigger'
import { extractRevertData } from '../neeru-indexer/rpc'

const router = Router()
const log = createLogger('routes:tx-status')

const HASH_RE = /^0x[0-9a-fA-F]{64}$/

// GET /api/tx/status?hash=0x...
//
// Wallet consumes this to skip the receipt-check + replay eth_call it
// runs today after every write. The endpoint queries the on-chain
// receipt directly (via Forno through the shared celoClient) and, when
// the tx reverted, replays the call at the block just before mining to
// extract the 4-byte custom-error selector.
//
// Response:
//   {status: 'pending'}
//     tx not mined yet (RPC returns "not found")
//   {status: 'success', blockNumber, transactionHash}
//     tx mined with receipt.status === 'success'
//   {status: 'reverted', blockNumber, transactionHash, revert: {selector, reason}}
//     tx mined and reverted. `selector` is the first 4 bytes of the
//     revert data (null if the RPC did not surface it). `reason` maps to
//     one of the known partner-contract custom errors when it matches
//     (INTEREST_POOL_LOW, ALREADY_CLOSED, NOT_OWNER); UNKNOWN otherwise.
router.get('/api/tx/status', async (req: Request, res: Response) => {
  const raw = req.query.hash
  if (typeof raw !== 'string' || !HASH_RE.test(raw)) {
    return res.status(400).json({ error: 'invalid hash' })
  }
  const hash = raw.toLowerCase() as `0x${string}`
  const client = getCeloPublicClient()

  let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>
  try {
    receipt = await client.getTransactionReceipt({ hash })
  } catch (err) {
    // viem throws TransactionReceiptNotFoundError when the tx is not
    // yet mined. Duck-type on the name/message rather than importing
    // the class so we do not couple to viem's internals across majors.
    const msg = err instanceof Error ? err.message : String(err)
    if (/not\s*found|could not be found/i.test(msg)) {
      return res.json({ status: 'pending' })
    }
    log.warn(`getTransactionReceipt failed for ${hash}: ${msg}`)
    return res.status(502).json({ error: 'rpc unavailable' })
  }

  if (receipt.status === 'success') {
    return res.json({
      status: 'success',
      blockNumber: receipt.blockNumber.toString(),
      transactionHash: receipt.transactionHash,
    })
  }

  // Reverted. Try to recover the revert selector by replaying the call at
  // the block just before it was mined. If replay is unavailable (network
  // error, no `input` on the tx, contract deploy revert, etc.) we still
  // return status: 'reverted' with revert.selector: null so the wallet
  // knows the tx failed even if we cannot classify why.
  const revert = await tryExtractRevertReason(client, hash, receipt.blockNumber)

  return res.json({
    status: 'reverted',
    blockNumber: receipt.blockNumber.toString(),
    transactionHash: receipt.transactionHash,
    revert,
  })
})

interface RevertInfo {
  selector: `0x${string}` | null
  reason: SimulationReason
}

async function tryExtractRevertReason(
  client: PublicClient,
  hash: `0x${string}`,
  blockNumber: bigint,
): Promise<RevertInfo> {
  const empty: RevertInfo = { selector: null, reason: 'UNKNOWN' }
  try {
    const tx = await client.getTransaction({ hash })
    if (!tx.to || !tx.input || tx.input === '0x') return empty
    const priorBlock = blockNumber > 0n ? blockNumber - 1n : 0n
    try {
      await client.call({
        account: tx.from,
        to: tx.to,
        data: tx.input,
        blockNumber: priorBlock,
      })
      // Call succeeded at the prior block -> tx failed only under the
      // exact state at its mining block. We cannot recover a selector
      // that way; the wallet will show a generic reverted state.
      return empty
    } catch (callErr) {
      const raw = extractRevertData(callErr)
      if (!raw || raw.length < 10) return empty
      const selector = raw.slice(0, 10).toLowerCase() as `0x${string}`
      const reason = REVERT_SELECTORS[selector] ?? 'UNKNOWN'
      return { selector, reason }
    }
  } catch (err) {
    log.warn(
      `revert replay failed for ${hash}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return empty
  }
}

export default router
