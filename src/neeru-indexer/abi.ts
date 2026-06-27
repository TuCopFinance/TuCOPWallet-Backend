import type { AbiFunction } from 'viem'

const ZERO_HEX_40 = '0x0000000000000000000000000000000000000000' as const
const ZERO_HEX_64 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const

function readEnvAddress(name: string): `0x${string}` {
  const v = process.env[name]
  if (!v) return ZERO_HEX_40
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`${name} must be 0x + 40 hex (got: ${v.length} chars)`)
  }
  return v as `0x${string}`
}

function readEnvTopic0(name: string): `0x${string}` {
  const v = process.env[name]
  if (!v) return ZERO_HEX_64
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${name} must be 0x + 64 hex (got: ${v.length} chars)`)
  }
  return v.toLowerCase() as `0x${string}`
}

export const CONTRACT_ADDRESS = readEnvAddress('NEERU_CONTRACT_ADDRESS')

export const INDEXER_GENESIS_BLOCK = BigInt(
  process.env.NEERU_INDEXER_GENESIS_BLOCK ?? '0',
)

export const EVENT_A_TOPIC0 = readEnvTopic0('NEERU_EVENT_A_TOPIC0')
export const EVENT_B_TOPIC0 = readEnvTopic0('NEERU_EVENT_B_TOPIC0')
export const EVENT_C_TOPIC0 = readEnvTopic0('NEERU_EVENT_C_TOPIC0')
export const EVENT_D_TOPIC0 = readEnvTopic0('NEERU_EVENT_D_TOPIC0')

export const EVENT_TOPIC0S = [
  EVENT_A_TOPIC0,
  EVENT_B_TOPIC0,
  EVENT_C_TOPIC0,
  EVENT_D_TOPIC0,
] as const

export const POSITIONS_FN_ABI = {
  type: 'function',
  name: 'positions',
  stateMutability: 'view',
  inputs: [{ name: '', type: 'uint256' }],
  outputs: [
    { name: 'r0', type: 'address' },
    { name: 'r1', type: 'uint8' },
    { name: 'r2', type: 'bool' },
    { name: 'r3', type: 'uint256' },
    { name: 'r4', type: 'uint256' },
    { name: 'r5', type: 'uint256' },
    { name: 'r6', type: 'uint256' },
    { name: 'r7', type: 'uint256' },
  ],
} as const satisfies AbiFunction

export const READ_ABI = [POSITIONS_FN_ABI] as const

export function assertIndexerConfig(): void {
  if (CONTRACT_ADDRESS === ZERO_HEX_40) {
    throw new Error('NEERU_CONTRACT_ADDRESS not set')
  }
  if (INDEXER_GENESIS_BLOCK === 0n) {
    throw new Error('NEERU_INDEXER_GENESIS_BLOCK not set')
  }
  const required: ReadonlyArray<readonly [string, `0x${string}`]> = [
    ['NEERU_EVENT_A_TOPIC0', EVENT_A_TOPIC0],
    ['NEERU_EVENT_B_TOPIC0', EVENT_B_TOPIC0],
    ['NEERU_EVENT_C_TOPIC0', EVENT_C_TOPIC0],
    ['NEERU_EVENT_D_TOPIC0', EVENT_D_TOPIC0],
  ]
  for (const [name, value] of required) {
    if (value === ZERO_HEX_64) {
      throw new Error(`${name} not set`)
    }
  }
}
