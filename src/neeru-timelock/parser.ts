// Decodes a raw log emitted by the admin Timelock into a typed variant.
// Only the three topic0s configured in env are recognised; everything else
// throws so a misconfigured Timelock (say, someone flipping the topics in
// env) does not silently write garbage rows.
//
// Layouts (canonical OpenZeppelin TimelockController):
//
//   CallScheduled(bytes32 indexed id, uint256 indexed index,
//                 address target, uint256 value, bytes data,
//                 bytes32 predecessor, uint256 delay)
//
//   CallExecuted(bytes32 indexed id, uint256 indexed index,
//                address target, uint256 value, bytes data)
//
//   Cancelled(bytes32 indexed id)

import { decodeAbiParameters } from 'viem'
import {
  EVENT_CANCELLED_TOPIC0,
  EVENT_EXECUTED_TOPIC0,
  EVENT_SCHEDULED_TOPIC0,
} from './abi'
import type { RawLog, TimelockEvent } from './types'

function decodeAddress(topic: `0x${string}` | null | undefined): `0x${string}` {
  if (!topic) throw new Error('missing indexed address topic')
  // Address is right-aligned in the 32-byte topic; take the last 20 bytes.
  return `0x${topic.slice(26).toLowerCase()}` as `0x${string}`
}

function decodeBytes32(
  topic: `0x${string}` | null | undefined,
): `0x${string}` {
  if (!topic) throw new Error('missing indexed bytes32 topic')
  return topic.toLowerCase() as `0x${string}`
}

export function parseTimelockLog(log: RawLog): TimelockEvent {
  const topic0 = log.topics[0]?.toLowerCase()
  if (!topic0) {
    throw new Error(
      `timelock log without topic0 at tx ${log.transactionHash} logIndex ${log.logIndex}`,
    )
  }

  const blockNumber = log.blockNumber
  const txHash = log.transactionHash
  const logIndex = log.logIndex

  switch (topic0) {
    case EVENT_SCHEDULED_TOPIC0.toLowerCase(): {
      const operationId = decodeBytes32(log.topics[1])
      const [target, value, calldata, predecessor, delay] = decodeAbiParameters(
        [
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes' },
          { type: 'bytes32' },
          { type: 'uint256' },
        ],
        log.data,
      )
      return {
        kind: 'scheduled',
        operationId,
        target: (target as string).toLowerCase() as `0x${string}`,
        value: value as bigint,
        calldata: calldata as `0x${string}`,
        predecessor: (predecessor as string).toLowerCase() as `0x${string}`,
        delay: delay as bigint,
        blockNumber,
        txHash,
        logIndex,
      }
    }

    case EVENT_EXECUTED_TOPIC0.toLowerCase(): {
      const operationId = decodeBytes32(log.topics[1])
      const [target, value, calldata] = decodeAbiParameters(
        [
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes' },
        ],
        log.data,
      )
      return {
        kind: 'executed',
        operationId,
        target: (target as string).toLowerCase() as `0x${string}`,
        value: value as bigint,
        calldata: calldata as `0x${string}`,
        blockNumber,
        txHash,
        logIndex,
      }
    }

    case EVENT_CANCELLED_TOPIC0.toLowerCase(): {
      const operationId = decodeBytes32(log.topics[1])
      return {
        kind: 'cancelled',
        operationId,
        blockNumber,
        txHash,
        logIndex,
      }
    }

    default:
      throw new Error(`unexpected timelock topic0: ${topic0}`)
  }
}

// Only persist events whose target is the tracked Neeru contract. The
// Timelock is shared, so we filter aggressively before writing.
export function isEventForContract(
  event: TimelockEvent,
  contractAddress: `0x${string}`,
): boolean {
  if (event.kind === 'cancelled') {
    // Cancelled carries no target; we accept it iff we already persisted a
    // matching scheduled event. That check lives in persistence, not here.
    return true
  }
  return event.target.toLowerCase() === contractAddress.toLowerCase()
}
// Address-topic decode helper (exported for tests + potential reuse).
export const _decodeAddress = decodeAddress
