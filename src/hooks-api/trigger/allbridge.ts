import {
  triggerClaimRewards as allbridgeTriggerClaimRewards,
  triggerDeposit as allbridgeTriggerDeposit,
  triggerWithdraw as allbridgeTriggerWithdraw,
} from '../../apps/allbridge'
import { HEX_ADDRESS_RE } from '../../lib/hex'

export interface AllbridgeTriggerBody {
  positionAddress?: unknown
  tokenAddress?: unknown
  tokenDecimals?: unknown
  tokens?: unknown
  [key: string]: unknown
}

export type DispatchResult =
  | { ok: true; payload: unknown }
  | { ok: false; status: number; error: string }

function isPositiveInt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  )
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)
}

interface AllbridgeTokenLeg {
  amount: string
}

function isAllbridgeTokens(value: unknown): value is AllbridgeTokenLeg[] {
  if (!Array.isArray(value)) return false
  for (const t of value) {
    if (!t || typeof t !== 'object') return false
    const amount = (t as { amount?: unknown }).amount
    if (!isDecimalString(amount)) return false
  }
  return true
}

export async function dispatchAllbridge(
  shortcutId: string,
  address: string,
  body: AllbridgeTriggerBody,
): Promise<DispatchResult> {
  if (shortcutId === 'deposit') {
    const positionAddress = body.positionAddress
    const tokenAddress = body.tokenAddress
    const tokenDecimals = body.tokenDecimals
    const tokens = body.tokens
    if (
      typeof positionAddress !== 'string' ||
      !HEX_ADDRESS_RE.test(positionAddress)
    ) {
      return { ok: false, status: 400, error: 'invalid positionAddress' }
    }
    if (typeof tokenAddress !== 'string' || !HEX_ADDRESS_RE.test(tokenAddress)) {
      return { ok: false, status: 400, error: 'invalid tokenAddress' }
    }
    if (!isPositiveInt(tokenDecimals)) {
      return { ok: false, status: 400, error: 'invalid tokenDecimals' }
    }
    if (!isAllbridgeTokens(tokens)) {
      return { ok: false, status: 400, error: 'invalid tokens' }
    }
    const result = await allbridgeTriggerDeposit({
      address,
      networkId: 'celo-mainnet',
      positionAddress,
      tokenAddress,
      tokenDecimals,
      tokens,
    })
    return { ok: true, payload: result }
  }
  if (shortcutId === 'withdraw') {
    const positionAddress = body.positionAddress
    const tokenDecimals = body.tokenDecimals
    const tokens = body.tokens
    if (
      typeof positionAddress !== 'string' ||
      !HEX_ADDRESS_RE.test(positionAddress)
    ) {
      return { ok: false, status: 400, error: 'invalid positionAddress' }
    }
    if (!isPositiveInt(tokenDecimals)) {
      return { ok: false, status: 400, error: 'invalid tokenDecimals' }
    }
    if (!isAllbridgeTokens(tokens)) {
      return { ok: false, status: 400, error: 'invalid tokens' }
    }
    const result = await allbridgeTriggerWithdraw({
      address,
      networkId: 'celo-mainnet',
      positionAddress,
      tokenDecimals,
      tokens,
    })
    return { ok: true, payload: result }
  }
  if (shortcutId === 'claim-rewards') {
    const positionAddress = body.positionAddress
    if (
      typeof positionAddress !== 'string' ||
      !HEX_ADDRESS_RE.test(positionAddress)
    ) {
      return { ok: false, status: 400, error: 'invalid positionAddress' }
    }
    const result = await allbridgeTriggerClaimRewards({
      address,
      networkId: 'celo-mainnet',
      positionAddress,
    })
    return { ok: true, payload: result }
  }
  return { ok: false, status: 400, error: 'unknown shortcut' }
}
