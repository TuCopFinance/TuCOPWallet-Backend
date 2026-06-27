// Ported from valora-inc/hooks (Apache-2.0).
// Original: https://github.com/valora-inc/hooks/blob/main/src/apps/allbridge/positions.ts
// License: Apache-2.0 - see LICENSE-ALLBRIDGE.md at repo root.
//
// Upstream encodes app identity as the directory name + the value
// returned by `PositionsHook.getInfo()`. We surface both explicitly here
// so the HTTP layer in PR 4 can dispatch on `appId === 'allbridge'`.

import type { NetworkId } from './types'

export const APP_ID = 'allbridge'
export const APP_NAME = 'Allbridge'

export interface Manifest {
  id: typeof APP_ID
  name: typeof APP_NAME
  networkIds: NetworkId[]
}

export const manifest: Manifest = {
  id: APP_ID,
  name: APP_NAME,
  // Backend scope is Celo only for now. Upstream supports more chains
  // but the spec (section 1) limits us to Celo.
  networkIds: ['celo-mainnet'],
}
