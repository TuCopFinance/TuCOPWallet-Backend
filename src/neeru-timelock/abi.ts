// Timelock monitor configuration surface. Address + topic0s are env-driven
// so a Timelock rotation or a new impl variant does not require a code
// change. The event ABI shapes are needed to decode the data blob after the
// selector match.

import { readEnvAddress, readEnvTopic0, ZERO_ADDRESS, ZERO_TOPIC } from '../lib/env'

export const TIMELOCK_ADDRESS = readEnvAddress('NEERU_TIMELOCK_ADDRESS')
export const NEERU_CONTRACT_ADDRESS = readEnvAddress('NEERU_CONTRACT_ADDRESS')

export const TIMELOCK_GENESIS_BLOCK = BigInt(
  process.env.NEERU_TIMELOCK_GENESIS_BLOCK ?? '0',
)

export const EVENT_SCHEDULED_TOPIC0 = readEnvTopic0(
  'NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0',
)
export const EVENT_EXECUTED_TOPIC0 = readEnvTopic0(
  'NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0',
)
export const EVENT_CANCELLED_TOPIC0 = readEnvTopic0(
  'NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0',
)

export const TIMELOCK_TOPIC0S = [
  EVENT_SCHEDULED_TOPIC0,
  EVENT_EXECUTED_TOPIC0,
  EVENT_CANCELLED_TOPIC0,
] as const

export function assertTimelockConfig(): void {
  if (TIMELOCK_ADDRESS === ZERO_ADDRESS) {
    throw new Error('NEERU_TIMELOCK_ADDRESS not set')
  }
  if (NEERU_CONTRACT_ADDRESS === ZERO_ADDRESS) {
    throw new Error('NEERU_CONTRACT_ADDRESS not set')
  }
  if (TIMELOCK_GENESIS_BLOCK === 0n) {
    throw new Error('NEERU_TIMELOCK_GENESIS_BLOCK not set')
  }
  const required: ReadonlyArray<readonly [string, `0x${string}`]> = [
    ['NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0', EVENT_SCHEDULED_TOPIC0],
    ['NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0', EVENT_EXECUTED_TOPIC0],
    ['NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0', EVENT_CANCELLED_TOPIC0],
  ]
  for (const [name, value] of required) {
    if (value === ZERO_TOPIC) {
      throw new Error(`${name} not set`)
    }
  }
}
