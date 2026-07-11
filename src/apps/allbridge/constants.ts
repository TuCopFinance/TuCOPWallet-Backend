// Ported from valora-inc/hooks (Apache-2.0).
// Original: https://github.com/valora-inc/hooks/blob/main/src/apps/allbridge/constants.ts
// License: Apache-2.0 - see LICENSES/allbridge.md at repo root.
//
// Same constants as upstream, narrowed to Celo. We keep the original
// keys (`CEL`, `ALLBRIDGE_LOGO`, etc.) so the `manageUrl` and image
// URLs match what the wallet already renders.

import type { NetworkId } from './types'

export enum AllbridgeChain {
  CEL = 'CEL',
}

export const ALLBRIDGE_LOGO =
  'https://raw.githubusercontent.com/valora-inc/dapp-list/main/assets/allbridgecore.png'

export const ALLBRIDGE_POOLS_BASE_URL = 'https://core.allbridge.io/pools'

export const NETWORK_ID_TO_ALLBRIDGE_CHAIN: Record<NetworkId, AllbridgeChain | undefined> = {
  'celo-mainnet': AllbridgeChain.CEL,
}

// Per-pool `contractCreatedAt` keyed by tokenId (`<networkId>:<lowercase-address>`).
// Same value upstream uses. The address is the Celo Allbridge pool
// (0xfb2C7c10e731EBe96Dabdf4A96D656Bfe8e2b5Af, lowercased).
export const ALLBRIDGE_CONTRACT_CREATED_AT: Record<string, string> = {
  'celo-mainnet:0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af': '2024-05-08T09:09:55.000Z',
}

export const ALLBRIDGE_TERMS_URL =
  'https://allbridge.io/assets/docs/Allbridge%20-%20Terms%20and%20Conditions.pdf'
