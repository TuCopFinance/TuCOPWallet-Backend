import { readEnvAddress, ZERO_ADDRESS } from '../lib/env'
import { createLogger } from '../lib/logger'

const log = createLogger('hooks-api:config')

export const NEERU_DEPOSIT_TOKEN_ADDRESS = readEnvAddress(
  'NEERU_DEPOSIT_TOKEN_ADDRESS',
  { lowercase: true },
)

export const NEERU_TRANCHE_IMAGE_URL_TEMPLATE =
  process.env.NEERU_TRANCHE_IMAGE_URL_TEMPLATE ?? ''

export const NEERU_MANAGE_URL = process.env.NEERU_MANAGE_URL ?? ''

export const NEERU_TERMS_URL = process.env.NEERU_TERMS_URL ?? ''

export const NEERU_CONTRACT_CREATED_AT_ISO =
  process.env.NEERU_CONTRACT_CREATED_AT_ISO ?? null

export function hooksApiConfigured(): boolean {
  return NEERU_DEPOSIT_TOKEN_ADDRESS !== ZERO_ADDRESS
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
