// EVM-style native-token sentinel used by Squid (and most aggregators).
// Substituted on the request to upstream when the wallet sets `*IsNative=true`.
export const NATIVE_TOKEN_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Mapping from the wallet's `NetworkId` slugs to numeric EVM chain IDs that
// Squid expects on /v2/route. Mirrors the keys in TuCopWallet
// `src/web3/networkConfig.ts` (`NetworkId` enum).
const NETWORK_ID_TO_CHAIN_ID: Record<string, number> = {
  'celo-mainnet': 42220,
  'ethereum-mainnet': 1,
  'arbitrum-one': 42161,
  'op-mainnet': 10,
  'polygon-pos-mainnet': 137,
  'base-mainnet': 8453,
}

export function networkIdToChainId(networkId: string): number | undefined {
  return NETWORK_ID_TO_CHAIN_ID[networkId]
}
