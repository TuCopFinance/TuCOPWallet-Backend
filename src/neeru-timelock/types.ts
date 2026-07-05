// Parsed Timelock events. Each variant carries the fields the persistence
// layer needs to write a row; the raw log topics/data blob does not escape
// the parser.

export interface RawLog {
  address: `0x${string}`
  topics: readonly (`0x${string}` | null)[]
  data: `0x${string}`
  blockNumber: bigint
  transactionHash: `0x${string}`
  logIndex: number
}

export interface ScheduledArgs {
  kind: 'scheduled'
  operationId: `0x${string}`
  target: `0x${string}`
  value: bigint
  calldata: `0x${string}`
  predecessor: `0x${string}`
  delay: bigint
  blockNumber: bigint
  txHash: `0x${string}`
  logIndex: number
}

export interface ExecutedArgs {
  kind: 'executed'
  operationId: `0x${string}`
  target: `0x${string}`
  value: bigint
  calldata: `0x${string}`
  blockNumber: bigint
  txHash: `0x${string}`
  logIndex: number
}

export interface CancelledArgs {
  kind: 'cancelled'
  operationId: `0x${string}`
  blockNumber: bigint
  txHash: `0x${string}`
  logIndex: number
}

export type TimelockEvent = ScheduledArgs | ExecutedArgs | CancelledArgs

export interface TimelockEventWithTimestamp {
  event: TimelockEvent
  blockTimestamp: bigint
}

export interface TimelockIndexerState {
  id: number
  lastScannedBlock: bigint
  lastScanAt: Date
  lastError: string | null
  lastErrorAt: Date | null
}
