import { decodeAbiParameters } from 'viem'
import { HEX_ADDRESS_LOWER_RE, HEX_BYTES32_RE } from '../lib/hex'
import {
  EVENT_A_TOPIC0,
  EVENT_B_TOPIC0,
  EVENT_C_TOPIC0,
  EVENT_D_TOPIC0,
} from './abi'
import type { NeeruLog } from './rpc'
import type {
  NeeruCategory,
  NeeruEventWithoutTimestamp,
} from './types'

export function isNeeruCategory(value: number): value is NeeruCategory {
  return value === 0 || value === 1 || value === 2 || value === 3
}

function ensureFullAddress(value: string, label: string): string {
  const lower = value.toLowerCase()
  if (!HEX_ADDRESS_LOWER_RE.test(lower)) {
    throw new Error(
      `neeru indexer: invalid ${label} address "${value}" - expected 0x + 40 lowercase hex`,
    )
  }
  return lower
}

function ensureFullTxHash(value: string | null, label: string): string {
  if (!value || !HEX_BYTES32_RE.test(value)) {
    throw new Error(
      `neeru indexer: invalid ${label} tx hash "${value ?? '<null>'}"`,
    )
  }
  return value.toLowerCase()
}

function decodeTopicAddress(topic: string | undefined): string {
  if (!topic) throw new Error('missing topic')
  return decodeAbiParameters(
    [{ type: 'address' }],
    topic as `0x${string}`,
  )[0] as string
}

function decodeTopicUint256(topic: string | undefined): bigint {
  if (!topic) throw new Error('missing topic')
  return decodeAbiParameters(
    [{ type: 'uint256' }],
    topic as `0x${string}`,
  )[0] as bigint
}

export function parseNeeruLog(entry: NeeruLog): NeeruEventWithoutTimestamp {
  const topic0 = entry.topics[0]?.toLowerCase()
  if (!topic0) {
    throw new Error(
      `log without topic0 at tx ${entry.transactionHash ?? '<unknown>'} logIndex ${entry.logIndex ?? -1}`,
    )
  }

  const txHash = ensureFullTxHash(entry.transactionHash, 'log')
  const blockNumber = entry.blockNumber
  const logIndex = entry.logIndex ?? -1
  const data = entry.data as `0x${string}`

  switch (topic0) {
    case EVENT_A_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const id = decodeTopicUint256(entry.topics[2])
      const [d0, d1, , d3] = decodeAbiParameters(
        [
          { type: 'uint8' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        data,
      )
      const cat = Number(d0)
      if (!isNeeruCategory(cat)) {
        throw new Error(
          `kind=a: unexpected category=${cat} id=${id.toString()} tx=${txHash}`,
        )
      }
      return {
        kind: 'a',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=a user'),
        id,
        category: cat,
        amount: d1,
        endTs: d3,
      }
    }
    case EVENT_B_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const id = decodeTopicUint256(entry.topics[2])
      return {
        kind: 'b',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=b user'),
        id,
      }
    }
    case EVENT_C_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const id = decodeTopicUint256(entry.topics[2])
      return {
        kind: 'c',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=c user'),
        id,
      }
    }
    case EVENT_D_TOPIC0.toLowerCase(): {
      const user = decodeTopicAddress(entry.topics[1])
      const oldId = decodeTopicUint256(entry.topics[2])
      const newId = decodeTopicUint256(entry.topics[3])
      const [d0, , , d3] = decodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        data,
      )
      return {
        kind: 'd',
        blockNumber,
        txHash,
        logIndex,
        user: ensureFullAddress(user, 'kind=d user'),
        oldId,
        newId,
        newAmount: d0,
        endTs: d3,
      }
    }
    default:
      throw new Error(`unexpected topic0: ${topic0}`)
  }
}
