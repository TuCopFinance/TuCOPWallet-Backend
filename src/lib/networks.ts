// EVM-style native-token sentinel used by Squid (and most aggregators).
// Substituted on the request to upstream when the wallet sets `*IsNative=true`.
export const NATIVE_TOKEN_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Canonical chain ID for Celo mainnet. Imported by routes/wri.ts, routes/events.ts,
// and anywhere else that talks to Celo. Single source of truth so a future
// chain-id change does not require a multi-file sweep.
export const CELO_MAINNET_CHAIN_ID = 42220

// EIP-7702 BatchExecutor v2 contract on Celo (public infra used by the
// delegate-relay route). Imported by routes/wri.ts and the transactions
// indexer classifier so the constant has one home.
export const BATCH_EXECUTOR_ADDRESS =
  '0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe' as const
export const BATCH_EXECUTOR_ADDRESS_LOWER = BATCH_EXECUTOR_ADDRESS.toLowerCase()

// EIP-7702 delegated-code prefix. When an EOA has accepted a delegation, its
// runtime code starts with `0xef0100` + the 20-byte delegate address.
export const EIP_7702_DELEGATED_CODE_PREFIX = '0xef0100'

// Mapping from the wallet's `NetworkId` slugs to numeric EVM chain IDs that
// Squid expects on /v2/route. Mirrors the keys in TuCopWallet
// `src/web3/networkConfig.ts` (`NetworkId` enum).
const NETWORK_ID_TO_CHAIN_ID: Record<string, number> = {
  'celo-mainnet': CELO_MAINNET_CHAIN_ID,
  'ethereum-mainnet': 1,
  'arbitrum-one': 42161,
  'op-mainnet': 10,
  'polygon-pos-mainnet': 137,
  'base-mainnet': 8453,
}

export function networkIdToChainId(networkId: string): number | undefined {
  return NETWORK_ID_TO_CHAIN_ID[networkId]
}
