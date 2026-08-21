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
