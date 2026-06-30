// Reusable zod primitives for route schemas. Lives outside per-route files
// so the regex sources (HEX_ADDRESS_LOWER_RE, etc.) are not duplicated and
// every route gets consistent error shapes ("invalid address" not
// "invalid wallet address").

import { z } from 'zod'
import {
  HEX_ADDRESS_LOWER_RE,
  HEX_ADDRESS_RE,
  HEX_BYTES32_RE,
} from '../../lib/hex'

// Address: 0x + 40 hex (any case). Use this when the route accepts a
// mixed-case address (most internal flows lowercase post-validation).
export const zHexAddress = z
  .string()
  .regex(HEX_ADDRESS_RE, { message: 'invalid address' })

// Lowercase address: 0x + 40 lower-hex. Use this when the wallet client is
// expected to lowercase before sending (swap, transactions-indexer feed).
export const zHexAddressLower = z
  .string()
  .regex(HEX_ADDRESS_LOWER_RE, { message: 'invalid address' })

// 32-byte hex (tx hashes, event topics, EIP-7702 signature r/s).
export const zHexBytes32 = z
  .string()
  .regex(HEX_BYTES32_RE, { message: 'invalid bytes32' })

// Boolean-as-string. Express query strings only ever come in as strings;
// "true" -> true, "false" -> false, anything else fails.
export const zBoolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')

// Short hex (any length, 0x + hex chars). Used by /api/wri/delegate-relay
// for chainId and nonce that the wallet encodes as variable-length hex.
const SHORT_HEX_RE = /^0x[a-fA-F0-9]*$/
export const zShortHex = z.string().regex(SHORT_HEX_RE, { message: 'invalid hex' })

// yParity is either '0x0' or '0x1'.
export const zYParity = z.enum(['0x0', '0x1']).transform((v) => (v === '0x1' ? 1 : 0))

// HTTP error helper: format a zod issue list as a single canonical
// "invalid <fieldname>" string. Routes use this to keep the error shape
// stable: { error: 'invalid sellToken' } not { error: 'sellToken: invalid address' }.
export function firstZodIssueAsError(err: z.ZodError): string {
  const issue = err.issues[0]
  if (!issue) return 'invalid request'
  // Path is typically [fieldname]. Prefix with "invalid" so the message
  // matches the legacy hand-rolled shape.
  const field = issue.path.join('.')
  return field ? `invalid ${field}` : (issue.message || 'invalid request')
}
