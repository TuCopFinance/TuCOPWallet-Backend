import { createHash } from 'crypto'

// Deterministic pseudonymisation for wallet addresses before they land
// in third-party stores (Sentry request context, Statsig userID).
//
// Wallet addresses ARE PII under Colombia's Habeas Data law when tied
// to KYC or on-chain history; they are also the primary user identifier
// on-chain. Two competing needs:
//
// - Traceability: an issue in Sentry / an event in Statsig has to be
//   correlatable back to a single user across requests. Random per-
//   request tokens would break this.
// - Confidentiality: we should not export raw addresses to third-party
//   PII stores. Even though addresses are on-chain-public, exporting
//   them shifts the compliance surface unnecessarily.
//
// SHA-256 hash truncated to 16 hex chars = 64 bits of pseudonym space,
// stable per address, non-reversible without a rainbow table. Optional
// `PII_HASH_SALT` env var pushes the reversal cost to unbounded (any
// rainbow table has to be rebuilt per salt).
//
// Collision math: with 64 bits of pseudonym and ~10^6 real users, the
// birthday-paradox collision probability is ~10^(-9). Adequate for
// analytics; do NOT use for security decisions.
export function hashWalletAddress(address: string | undefined): string | undefined {
  if (!address) return undefined
  const salt = process.env.PII_HASH_SALT ?? ''
  const digest = createHash('sha256').update(salt + address.toLowerCase()).digest('hex')
  return `wp_${digest.slice(0, 16)}`
}
