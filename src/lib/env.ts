import { HEX_ADDRESS_RE, HEX_BYTES32_RE } from './hex'
import { createLogger } from './logger'

const log = createLogger('lib:env')

const ZERO_HEX_40 = '0x0000000000000000000000000000000000000000' as const
const ZERO_HEX_64 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const

export type ZeroAddress = typeof ZERO_HEX_40
export type ZeroTopic = typeof ZERO_HEX_64

export const ZERO_ADDRESS: ZeroAddress = ZERO_HEX_40
export const ZERO_TOPIC: ZeroTopic = ZERO_HEX_64

interface ReadEnvAddressOptions {
  lowercase?: boolean
}

export function readEnvAddress(
  name: string,
  options: ReadEnvAddressOptions = {},
): `0x${string}` {
  const v = process.env[name]
  if (!v) return ZERO_HEX_40
  if (!HEX_ADDRESS_RE.test(v)) {
    throw new Error(`${name} must be 0x + 40 hex (got: ${v.length} chars)`)
  }
  return (options.lowercase ? v.toLowerCase() : v) as `0x${string}`
}

export function readEnvTopic0(name: string): `0x${string}` {
  const v = process.env[name]
  if (!v) return ZERO_HEX_64
  if (!HEX_BYTES32_RE.test(v)) {
    throw new Error(`${name} must be 0x + 64 hex (got: ${v.length} chars)`)
  }
  return v.toLowerCase() as `0x${string}`
}

export function parseEnvBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (!raw) return fallback
  try {
    const v = BigInt(raw)
    if (v < 0n) {
      log.warn(`${name} is negative; using fallback ${fallback.toString()}`)
      return fallback
    }
    return v
  } catch {
    log.warn(
      `${name} is not a valid integer (got: "${raw}"); using fallback ${fallback.toString()}`,
    )
    return fallback
  }
}
