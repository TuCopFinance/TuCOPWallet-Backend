// Ported from valora-inc/hooks (Apache-2.0).
// Original: https://github.com/valora-inc/hooks/tree/main/src/apps/allbridge
// License: Apache-2.0 - see LICENSES/allbridge.md at repo root.
//
// Public surface for the Allbridge app port. The HTTP layer added in PR 4
// imports from here only.

export { manifest, APP_ID, APP_NAME, type Manifest } from './manifest'
export {
  getPositions,
  getTokenId,
  getRewardPositionId,
  type GetPositionsArgs,
} from './positions'
export {
  getShortcuts,
  triggerDeposit,
  triggerWithdraw,
  triggerClaimRewards,
} from './shortcuts'
export type {
  AppTokenPosition,
  BaseToken,
  ClaimRewardsTriggerArgs,
  ContractPosition,
  DepositTriggerArgs,
  EarnDataProps,
  NetworkId,
  Position,
  PreparedTransaction,
  SerializedDecimalNumber,
  ShortcutDefinition,
  TriggerResult,
  WithdrawTriggerArgs,
} from './types'
export { ClaimType } from './types'
