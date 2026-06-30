export type NeeruCategory = 0 | 1 | 2 | 3

export interface NeeruPosition {
  positionId: bigint
  userAddress: string
  category: NeeruCategory
  amount: bigint
  startTs: bigint
  endTs: bigint
  depositBlock: bigint
  depositTxHash: string
  closed: boolean
  closedAtTs: bigint | null
  closedBlock: bigint | null
  closedTxHash: string | null
  createdAt: Date
  updatedAt: Date
}

export interface NeeruIndexerState {
  id: 1
  lastScannedBlock: bigint
  lastScanAt: Date
  lastError: string | null
  lastErrorAt: Date | null
}

interface NeeruEventBase {
  blockNumber: bigint
  blockTimestamp: bigint
  txHash: string
  logIndex: number
  user: string
}

export interface NeeruKindAEvent extends NeeruEventBase {
  kind: 'a'
  id: bigint
  category: NeeruCategory
  amount: bigint
  endTs: bigint
}

export interface NeeruKindBEvent extends NeeruEventBase {
  kind: 'b'
  id: bigint
}

export interface NeeruKindCEvent extends NeeruEventBase {
  kind: 'c'
  id: bigint
}

export interface NeeruKindDEvent extends NeeruEventBase {
  kind: 'd'
  oldId: bigint
  newId: bigint
  newAmount: bigint
  endTs: bigint
}

export type NeeruEvent =
  | NeeruKindAEvent
  | NeeruKindBEvent
  | NeeruKindCEvent
  | NeeruKindDEvent

export type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never

export type NeeruEventWithoutTimestamp = DistributiveOmit<
  NeeruEvent,
  'blockTimestamp'
>

export type KindAArgs = NeeruKindAEvent
export type KindBArgs = NeeruKindBEvent
export type KindCArgs = NeeruKindCEvent
export type KindDArgs = NeeruKindDEvent

export interface NeeruOnchainBatchContext {
  positionCategory: Map<string, number>
  blockTimestamps: Map<string, bigint>
  lockSecondsByCategory: Map<NeeruCategory, bigint>
}
