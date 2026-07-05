// Parser test uses the ACTUAL keccak-derived topic0s for the OZ
// TimelockController events. The abi.ts module reads them from env at
// import time, so the test sets those envs BEFORE requiring the parser.

const SCHEDULED_TOPIC0 =
  '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca'
const EXECUTED_TOPIC0 =
  '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58'
const CANCELLED_TOPIC0 =
  '0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'

const TIMELOCK_ADDRESS = '0xe8358c9cfa4f7af8acd6ff86e012d828527497bf'
const CONTRACT_ADDRESS = '0x988af5977201a0e988f2c75ea952532f6beb5082'
const OTHER_ADDRESS = '0x1234567890123456789012345678901234567890'

process.env.NEERU_TIMELOCK_ADDRESS = TIMELOCK_ADDRESS
process.env.NEERU_CONTRACT_ADDRESS = CONTRACT_ADDRESS
process.env.NEERU_TIMELOCK_GENESIS_BLOCK = '1234568'
process.env.NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0 = SCHEDULED_TOPIC0
process.env.NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0 = EXECUTED_TOPIC0
process.env.NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0 = CANCELLED_TOPIC0

import { encodeAbiParameters } from 'viem'
import { isEventForContract, parseTimelockLog } from './parser'
import type { RawLog } from './types'

const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const INDEX_TOPIC =
  '0x0000000000000000000000000000000000000000000000000000000000000000'
const PREDECESSOR =
  '0x0000000000000000000000000000000000000000000000000000000000000000'
const UPGRADE_CALLDATA =
  '0x1b2ac00c00000000000000000000000000000000000000000000000000000000deadbeef'

function scheduledLog(target: string): RawLog {
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'bytes32' },
      { type: 'uint256' },
    ],
    [
      target as `0x${string}`,
      0n,
      UPGRADE_CALLDATA as `0x${string}`,
      PREDECESSOR as `0x${string}`,
      172800n,
    ],
  )
  return {
    address: TIMELOCK_ADDRESS as `0x${string}`,
    topics: [
      SCHEDULED_TOPIC0 as `0x${string}`,
      OP_ID as `0x${string}`,
      INDEX_TOPIC as `0x${string}`,
    ],
    data,
    blockNumber: 1234700n,
    transactionHash:
      '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`,
    logIndex: 3,
  }
}

function executedLog(target: string): RawLog {
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bytes' },
    ],
    [target as `0x${string}`, 0n, UPGRADE_CALLDATA as `0x${string}`],
  )
  return {
    address: TIMELOCK_ADDRESS as `0x${string}`,
    topics: [
      EXECUTED_TOPIC0 as `0x${string}`,
      OP_ID as `0x${string}`,
      INDEX_TOPIC as `0x${string}`,
    ],
    data,
    blockNumber: 1234900n,
    transactionHash:
      '0x2222222222222222222222222222222222222222222222222222222222222222' as `0x${string}`,
    logIndex: 1,
  }
}

function cancelledLog(): RawLog {
  return {
    address: TIMELOCK_ADDRESS as `0x${string}`,
    topics: [CANCELLED_TOPIC0 as `0x${string}`, OP_ID as `0x${string}`],
    data: '0x' as `0x${string}`,
    blockNumber: 1234800n,
    transactionHash:
      '0x3333333333333333333333333333333333333333333333333333333333333333' as `0x${string}`,
    logIndex: 0,
  }
}

describe('parseTimelockLog', () => {
  it('decodes CallScheduled targeting the contract', () => {
    const event = parseTimelockLog(scheduledLog(CONTRACT_ADDRESS))
    expect(event.kind).toBe('scheduled')
    if (event.kind !== 'scheduled') return
    expect(event.operationId.toLowerCase()).toBe(OP_ID.toLowerCase())
    expect(event.target).toBe(CONTRACT_ADDRESS)
    expect(event.value).toBe(0n)
    expect(event.calldata.toLowerCase()).toBe(UPGRADE_CALLDATA.toLowerCase())
    expect(event.predecessor).toBe(PREDECESSOR.toLowerCase())
    expect(event.delay).toBe(172800n)
    expect(event.blockNumber).toBe(1234700n)
    expect(event.logIndex).toBe(3)
  })

  it('decodes CallScheduled targeting an unrelated address', () => {
    const event = parseTimelockLog(scheduledLog(OTHER_ADDRESS))
    expect(event.kind).toBe('scheduled')
    if (event.kind !== 'scheduled') return
    expect(event.target).toBe(OTHER_ADDRESS)
  })

  it('decodes CallExecuted', () => {
    const event = parseTimelockLog(executedLog(CONTRACT_ADDRESS))
    expect(event.kind).toBe('executed')
    if (event.kind !== 'executed') return
    expect(event.operationId.toLowerCase()).toBe(OP_ID.toLowerCase())
    expect(event.target).toBe(CONTRACT_ADDRESS)
    expect(event.value).toBe(0n)
    expect(event.calldata.toLowerCase()).toBe(UPGRADE_CALLDATA.toLowerCase())
  })

  it('decodes Cancelled', () => {
    const event = parseTimelockLog(cancelledLog())
    expect(event.kind).toBe('cancelled')
    if (event.kind !== 'cancelled') return
    expect(event.operationId.toLowerCase()).toBe(OP_ID.toLowerCase())
  })

  it('throws on unknown topic0', () => {
    const bogus: RawLog = {
      address: TIMELOCK_ADDRESS as `0x${string}`,
      topics: [
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`,
      ],
      data: '0x' as `0x${string}`,
      blockNumber: 1n,
      transactionHash: '0x' as `0x${string}`,
      logIndex: 0,
    }
    expect(() => parseTimelockLog(bogus)).toThrow(/unexpected timelock topic0/)
  })
})

describe('isEventForContract', () => {
  it('accepts scheduled targeting the contract', () => {
    const ev = parseTimelockLog(scheduledLog(CONTRACT_ADDRESS))
    expect(isEventForContract(ev, CONTRACT_ADDRESS as `0x${string}`)).toBe(true)
  })

  it('rejects scheduled targeting another address', () => {
    const ev = parseTimelockLog(scheduledLog(OTHER_ADDRESS))
    expect(isEventForContract(ev, CONTRACT_ADDRESS as `0x${string}`)).toBe(false)
  })

  it('accepts executed targeting the contract', () => {
    const ev = parseTimelockLog(executedLog(CONTRACT_ADDRESS))
    expect(isEventForContract(ev, CONTRACT_ADDRESS as `0x${string}`)).toBe(true)
  })

  it('always accepts cancelled (target filter happens in persistence via hasKnownOperation)', () => {
    const ev = parseTimelockLog(cancelledLog())
    expect(isEventForContract(ev, CONTRACT_ADDRESS as `0x${string}`)).toBe(true)
  })
})
