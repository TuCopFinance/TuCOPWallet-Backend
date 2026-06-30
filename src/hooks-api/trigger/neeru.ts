import { getDb } from '../../lib/db'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import { hooksApiConfigured } from '../config'
import {
  buildDepositTxs,
  buildWithdrawPrincipalOnlyTxs,
  buildWithdrawTxs,
} from '../neeru/trigger'
import type { DispatchResult } from './allbridge'

export interface NeeruTriggerBody {
  trancheId?: unknown
  tokens?: unknown
  positionId?: unknown
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

function isDigitString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

export interface DispatchNeeruDeps {
  rpc: NeeruIndexerRpcClient
}

export async function dispatchNeeru(
  shortcutId: string,
  address: string,
  body: NeeruTriggerBody,
  deps: DispatchNeeruDeps,
): Promise<DispatchResult> {
  if (!hooksApiConfigured()) {
    return { ok: false, status: 503, error: 'neeru not configured' }
  }

  if (shortcutId === 'deposit') {
    const trancheId = body.trancheId
    const tokens = body.tokens
    if (!isPositiveInt(trancheId)) {
      return { ok: false, status: 400, error: 'invalid trancheId' }
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
      trancheId,
      amount: first.amount,
      rpc: deps.rpc,
    })
    return { ok: true, payload: result }
  }

  if (shortcutId === 'withdraw' || shortcutId === 'withdraw-principal-only') {
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
            rpc: deps.rpc,
            db,
          })
        : await buildWithdrawPrincipalOnlyTxs({
            address,
            positionId,
            rpc: deps.rpc,
            db,
          })
    return { ok: true, payload: result }
  }

  return { ok: false, status: 400, error: 'unknown shortcut' }
}
