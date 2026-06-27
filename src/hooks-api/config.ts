import { createLogger } from '../lib/logger'

const log = createLogger('hooks-api:config')

const ZERO_HEX_40 = '0x0000000000000000000000000000000000000000' as const

function readEnvAddress(name: string): `0x${string}` {
  const v = process.env[name]
  if (!v) return ZERO_HEX_40
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`${name} must be 0x + 40 hex (got: ${v.length} chars)`)
  }
  return v.toLowerCase() as `0x${string}`
}

export const NEERU_DEPOSIT_TOKEN_ADDRESS = readEnvAddress(
  'NEERU_DEPOSIT_TOKEN_ADDRESS',
)

export const NEERU_TRANCHE_IMAGE_URL_TEMPLATE =
  process.env.NEERU_TRANCHE_IMAGE_URL_TEMPLATE ?? ''

export const NEERU_MANAGE_URL = process.env.NEERU_MANAGE_URL ?? ''

export const NEERU_TERMS_URL = process.env.NEERU_TERMS_URL ?? ''

export const NEERU_CONTRACT_CREATED_AT_ISO =
  process.env.NEERU_CONTRACT_CREATED_AT_ISO ?? null

export function hooksApiConfigured(): boolean {
  return NEERU_DEPOSIT_TOKEN_ADDRESS !== ZERO_HEX_40
}

export function assertHooksApiConfig(): void {
  if (!hooksApiConfigured()) {
    throw new Error('NEERU_DEPOSIT_TOKEN_ADDRESS not set')
  }
  if (!NEERU_TRANCHE_IMAGE_URL_TEMPLATE) {
    log.warn('NEERU_TRANCHE_IMAGE_URL_TEMPLATE not set; imageUrl will be empty')
  }
  if (!NEERU_MANAGE_URL) {
    log.warn('NEERU_MANAGE_URL not set; manageUrl will be empty')
  }
  if (!NEERU_TERMS_URL) {
    log.warn('NEERU_TERMS_URL not set; termsUrl will be empty')
  }
  if (!NEERU_CONTRACT_CREATED_AT_ISO) {
    log.warn(
      'NEERU_CONTRACT_CREATED_AT_ISO not set; contractCreatedAt will be null',
    )
  }
}

export function trancheImageUrl(category: 0 | 1 | 2 | 3): string {
  if (!NEERU_TRANCHE_IMAGE_URL_TEMPLATE) return ''
  return NEERU_TRANCHE_IMAGE_URL_TEMPLATE.replace('{N}', String(category))
}
