// Shared regex constants for the common EVM-shaped strings the public API
// validates. Each route imports the one it needs instead of redeclaring it.

// 0x + 40 hex (case-insensitive). Use this for any address coming in over the
// public API where the wallet may or may not have lowercased it.
export const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// 0x + 40 lowercase hex. Used by the swap quote route, which deliberately
// rejects any uppercase characters in the address so a single canonical form
// flows into the upstream cache key.
export const HEX_ADDRESS_LOWER_RE = /^0x[a-f0-9]{40}$/

// 0x + 64 hex (case-insensitive). Used for tx hashes and event topics.
export const HEX_BYTES32_RE = /^0x[a-fA-F0-9]{64}$/

// Branded address / tx-hash types. The brand is a phantom field that exists
// only in the type system, so an arbitrary `string` cannot be assigned to
// `Address` without going through `asAddress`/`asLowerAddress`/`asTxHash`.
// Existing code that treats addresses as bare `string` keeps compiling; new
// code can opt in by accepting `Address` to lock the invariant at the type
// boundary.

declare const ADDRESS_BRAND: unique symbol
declare const LOWER_ADDRESS_BRAND: unique symbol
declare const TX_HASH_BRAND: unique symbol

export type Address = `0x${string}` & { readonly [ADDRESS_BRAND]: true }
export type LowerAddress = Address & {
  readonly [LOWER_ADDRESS_BRAND]: true
}
export type TxHash = `0x${string}` & { readonly [TX_HASH_BRAND]: true }

export function asAddress(value: string): Address | null {
  return HEX_ADDRESS_RE.test(value) ? (value as Address) : null
}

export function asLowerAddress(value: string): LowerAddress | null {
  if (!HEX_ADDRESS_RE.test(value)) return null
  return value.toLowerCase() as LowerAddress
}

export function asTxHash(value: string): TxHash | null {
  return HEX_BYTES32_RE.test(value) ? (value as TxHash) : null
}
