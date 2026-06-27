// Re-exports the canonical Position / shortcut shape that the wallet
// already consumes (originally defined for the Allbridge port, ported
// verbatim from valora-inc/hooks). Keeping the union centralised here
// avoids drifting between the two app modules.

export type {
  AppTokenPosition,
  BaseToken,
  ContractPosition,
  DisplayProps,
  EarnDataProps,
  EarningItem,
  NetworkId,
  Position,
  Safety,
  SafetyRisk,
  SerializedDecimalNumber,
  ShortcutDefinition,
  YieldRate,
} from '../../apps/allbridge/types'

// EarnPosition is the catalogue-style entry that the wallet expects from
// `/hooks-api/getEarnPositions`. For Neeru every entry is an
// AppTokenPosition (a category behaves like a single supply position).
import type { AppTokenPosition } from '../../apps/allbridge/types'
export type EarnPosition = AppTokenPosition
