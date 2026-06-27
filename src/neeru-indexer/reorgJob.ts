import type { Pool } from 'pg'
import { createLogger } from '../lib/logger'
import { CONTRACT_ADDRESS, READ_ABI } from './abi'
import type { NeeruIndexerRpcClient } from './rpc'

const log = createLogger('neeru-indexer:reorg')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MULTICALL_CHUNK_SIZE = 100

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
        shouldDelete = true
        onchainStatus = `revert: ${result.error.message}`
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
