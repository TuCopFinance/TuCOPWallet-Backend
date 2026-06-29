import type { Pool } from 'pg'
import { createLogger } from '../lib/logger'
import { CONTRACT_ADDRESS, READ_ABI } from './abi'
import type { NeeruIndexerRpcClient } from './rpc'

const log = createLogger('neeru-indexer:reorg')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MULTICALL_CHUNK_SIZE = 100
// On a failed multicall entry, retry the row as a single readContract before
// concluding it should be deleted. allowFailure mixes "tx reverted on chain"
// with "RPC transport blip on this one entry"; a single re-read distinguishes
// transient infra failures from real contract reverts.
const SINGLE_RETRY_TIMEOUT_LABEL = 'positions-retry'

export interface RunReorgReconciliationOptions {
  db: Pool
  rpc: NeeruIndexerRpcClient
  nowFn?: () => Date
}

export interface RunReorgReconciliationResult {
  scanned: number
  deleted: number
}

interface CandidateRow {
  position_id: string
  deposit_tx_hash: string
  deposit_block: string
}

export async function runReorgReconciliation(
  options: RunReorgReconciliationOptions,
): Promise<RunReorgReconciliationResult> {
  const { db, rpc } = options

  const { rows } = await db.query<CandidateRow>(
    `SELECT position_id::text AS position_id,
            deposit_tx_hash,
            deposit_block::text AS deposit_block
       FROM neeru_positions
      WHERE created_at >= NOW() - INTERVAL '24 hours'`,
  )

  if (rows.length === 0) {
    log.info('reorg reconciliation: no rows in last 24h, nothing to scan')
    return { scanned: 0, deleted: 0 }
  }

  let deleted = 0
  for (let offset = 0; offset < rows.length; offset += MULTICALL_CHUNK_SIZE) {
    const slice = rows.slice(offset, offset + MULTICALL_CHUNK_SIZE)
    const contracts = slice.map((row) => ({
      address: CONTRACT_ADDRESS,
      abi: READ_ABI,
      functionName: 'positions' as const,
      args: [BigInt(row.position_id)] as const,
    }))

    const results = (await rpc.multicall({
      contracts: contracts as unknown as Parameters<
        NeeruIndexerRpcClient['multicall']
      >[0]['contracts'],
      allowFailure: true,
    })) as ReadonlyArray<
      | { status: 'success'; result: readonly unknown[] }
      | { status: 'failure'; error: Error }
    >

    for (let i = 0; i < slice.length; i++) {
      const row = slice[i]
      const result = results[i]
      if (!row || !result) continue
      const positionId = row.position_id
      const depositTxHash = row.deposit_tx_hash
      const depositBlock = row.deposit_block

      let shouldDelete = false
      let onchainStatus: string

      if (result.status === 'failure') {
        // Single retry to distinguish a transient RPC blip on this entry
        // from a genuine on-chain revert. The original multicall error is
        // preserved in the log line so operators can see the contract's
        // revert reason; the retry only decides whether we should delete.
        const originalError = result.error.message
        const retried = await retryPositionsRead(rpc, BigInt(positionId))
        if (retried.kind === 'transient') {
          onchainStatus = `transient: ${retried.error} - keeping row`
          log.warn(
            `[neeru:reorg] transient failure on positionId=${positionId} depositBlock=${depositBlock} depositTxHash=${depositTxHash} (${SINGLE_RETRY_TIMEOUT_LABEL}): ${onchainStatus} (original=${originalError})`,
          )
          continue
        } else if (retried.kind === 'reverted') {
          shouldDelete = true
          onchainStatus = `revert: ${originalError}`
        } else {
          const ownerStr = retried.ownerLower
          if (ownerStr === ZERO_ADDRESS) {
            shouldDelete = true
            onchainStatus = 'owner=0x0000000000000000000000000000000000000000'
          } else {
            onchainStatus = `owner=${ownerStr} - on-chain row present (recovered)`
          }
        }
      } else {
        const owner = result.result[0]
        const ownerStr =
          typeof owner === 'string' ? owner.toLowerCase() : String(owner)
        if (ownerStr === ZERO_ADDRESS) {
          shouldDelete = true
          onchainStatus = 'owner=0x0000000000000000000000000000000000000000'
        } else {
          onchainStatus = `owner=${ownerStr} - on-chain row present`
        }
      }

      if (shouldDelete) {
        const deleteResult = await db.query(
          'DELETE FROM neeru_positions WHERE position_id = $1',
          [positionId],
        )
        if ((deleteResult.rowCount ?? 0) > 0) {
          deleted += 1
        }
        log.warn(
          `[neeru:reorg] deleted reorged row positionId=${positionId} depositBlock=${depositBlock} depositTxHash=${depositTxHash} onchainStatus="${onchainStatus}"`,
        )
      }
    }
  }

  log.info(
    `reorg reconciliation complete: scanned=${rows.length} deleted=${deleted}`,
  )
  return { scanned: rows.length, deleted }
}

// "Transport" or "ECONNREFUSED" or "fetch failed" markers in the error message
// are treated as transient; anything else (including viem `ContractFunctionRevertedError`
// or a parsed revert reason) is treated as a real revert.
const TRANSIENT_PATTERNS = [
  /fetch failed/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /timeout/i,
  /5\d{2}/, // any 5xx status echoed in the message
  /network/i,
  /socket hang up/i,
]

type RetryResult =
  | { kind: 'transient'; error: string }
  | { kind: 'reverted'; error: string }
  | { kind: 'success'; ownerLower: string }

async function retryPositionsRead(
  rpc: NeeruIndexerRpcClient,
  positionId: bigint,
): Promise<RetryResult> {
  try {
    const raw = (await rpc.readContract({
      address: CONTRACT_ADDRESS,
      abi: READ_ABI,
      functionName: 'positions',
      args: [positionId] as unknown as readonly [bigint],
    })) as readonly unknown[]
    const owner = raw[0]
    const ownerStr =
      typeof owner === 'string' ? owner.toLowerCase() : String(owner)
    return { kind: 'success', ownerLower: ownerStr }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const transient = TRANSIENT_PATTERNS.some((re) => re.test(message))
    return transient
      ? { kind: 'transient', error: message }
      : { kind: 'reverted', error: message }
  }
}
