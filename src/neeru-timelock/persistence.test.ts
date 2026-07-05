// The persistence module uses `isEventForContract` from parser, which reads
// the abi module at import time. Set envs before importing.

process.env.NEERU_TIMELOCK_ADDRESS =
  '0xe8358c9cfa4f7af8acd6ff86e012d828527497bf'
process.env.NEERU_CONTRACT_ADDRESS =
  '0x988af5977201a0e988f2c75ea952532f6beb5082'
process.env.NEERU_TIMELOCK_GENESIS_BLOCK = '70876544'
process.env.NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0 =
  '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca'
process.env.NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0 =
  '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58'
process.env.NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0 =
  '0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'

import {
  dispatchTimelockEvent,
  insertCancelled,
  insertExecuted,
  insertScheduled,
  NEERU_TIMELOCK_ADVISORY_LOCK_KEY,
  releaseTimelockLock,
  tryAcquireTimelockLock,
} from './persistence'
import type { TimelockEventWithTimestamp } from './types'

const CONTRACT_ADDRESS =
  '0x988af5977201a0e988f2c75ea952532f6beb5082' as `0x${string}`
const OTHER_ADDRESS =
  '0x1234567890123456789012345678901234567890' as `0x${string}`
const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`
const PREDECESSOR =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
const CALLDATA = '0x1b2ac00cdeadbeef' as `0x${string}`

interface Recorded {
  sql: string
  params: readonly unknown[]
}

function buildFakeClient(opts: {
  scheduledExists?: boolean
} = {}) {
  const queries: Recorded[] = []
  const scheduledExists = opts.scheduledExists ?? false
  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const norm = sql.trim().toUpperCase()
      if (norm.startsWith('SELECT EXISTS')) {
        return { rows: [{ exists: scheduledExists }] }
      }
      return { rows: [] }
    },
  }
  return { client, queries }
}

describe('insertScheduled', () => {
  it('writes a row with computed ready_ts', async () => {
    const { client, queries } = buildFakeClient()
    await insertScheduled(client as never, {
      operationId: OP_ID,
      target: CONTRACT_ADDRESS,
      value: 0n,
      calldata: CALLDATA,
      predecessor: PREDECESSOR,
      delay: 172800n,
      blockNumber: 70942000n,
      blockTimestamp: 1783260000n,
      txHash: '0xdead',
      logIndex: 2,
    })
    expect(queries.length).toBe(1)
    const insert = queries[0]!
    expect(insert.sql).toMatch(/INSERT INTO neeru_upgrade_events/)
    expect(insert.sql).toMatch(/'scheduled'/)
    // ready_ts must be blockTimestamp + delay
    expect(insert.params).toEqual([
      OP_ID,
      CONTRACT_ADDRESS,
      '0',
      CALLDATA,
      PREDECESSOR,
      '172800',
      (1783260000n + 172800n).toString(),
      '70942000',
      '1783260000',
      '0xdead',
      2,
    ])
  })
})

describe('insertExecuted', () => {
  it('writes an executed row', async () => {
    const { client, queries } = buildFakeClient()
    await insertExecuted(client as never, {
      operationId: OP_ID,
      target: CONTRACT_ADDRESS,
      value: 0n,
      calldata: CALLDATA,
      blockNumber: 70950000n,
      blockTimestamp: 1783300000n,
      txHash: '0xbeef',
      logIndex: 1,
    })
    expect(queries.length).toBe(1)
    expect(queries[0]!.sql).toMatch(/'executed'/)
  })
})

describe('insertCancelled', () => {
  it('writes a cancelled row', async () => {
    const { client, queries } = buildFakeClient()
    await insertCancelled(client as never, {
      operationId: OP_ID,
      blockNumber: 70945000n,
      blockTimestamp: 1783280000n,
      txHash: '0xcafe',
      logIndex: 0,
    })
    expect(queries.length).toBe(1)
    expect(queries[0]!.sql).toMatch(/'cancelled'/)
  })
})

describe('dispatchTimelockEvent', () => {
  it('inserts a scheduled event targeting the tracked contract', async () => {
    const { client, queries } = buildFakeClient()
    const evt: TimelockEventWithTimestamp = {
      blockTimestamp: 1783260000n,
      event: {
        kind: 'scheduled',
        operationId: OP_ID,
        target: CONTRACT_ADDRESS,
        value: 0n,
        calldata: CALLDATA,
        predecessor: PREDECESSOR,
        delay: 172800n,
        blockNumber: 70942000n,
        txHash: '0xdead' as `0x${string}`,
        logIndex: 2,
      },
    }
    await dispatchTimelockEvent(client as never, evt, CONTRACT_ADDRESS)
    expect(queries.some((q) => q.sql.includes("'scheduled'"))).toBe(true)
  })

  it('skips scheduled events targeting a different address', async () => {
    const { client, queries } = buildFakeClient()
    const evt: TimelockEventWithTimestamp = {
      blockTimestamp: 1783260000n,
      event: {
        kind: 'scheduled',
        operationId: OP_ID,
        target: OTHER_ADDRESS,
        value: 0n,
        calldata: CALLDATA,
        predecessor: PREDECESSOR,
        delay: 172800n,
        blockNumber: 70942000n,
        txHash: '0xdead' as `0x${string}`,
        logIndex: 2,
      },
    }
    await dispatchTimelockEvent(client as never, evt, CONTRACT_ADDRESS)
    expect(queries.length).toBe(0)
  })

  it('accepts executed events for known operations even if target field is off', async () => {
    const { client, queries } = buildFakeClient({ scheduledExists: true })
    const evt: TimelockEventWithTimestamp = {
      blockTimestamp: 1783300000n,
      event: {
        kind: 'executed',
        operationId: OP_ID,
        target: OTHER_ADDRESS,
        value: 0n,
        calldata: CALLDATA,
        blockNumber: 70950000n,
        txHash: '0xbeef' as `0x${string}`,
        logIndex: 1,
      },
    }
    await dispatchTimelockEvent(client as never, evt, CONTRACT_ADDRESS)
    expect(queries.some((q) => q.sql.includes("'executed'"))).toBe(true)
  })

  it('skips executed events for unknown operations targeting another contract', async () => {
    const { client, queries } = buildFakeClient({ scheduledExists: false })
    const evt: TimelockEventWithTimestamp = {
      blockTimestamp: 1783300000n,
      event: {
        kind: 'executed',
        operationId: OP_ID,
        target: OTHER_ADDRESS,
        value: 0n,
        calldata: CALLDATA,
        blockNumber: 70950000n,
        txHash: '0xbeef' as `0x${string}`,
        logIndex: 1,
      },
    }
    await dispatchTimelockEvent(client as never, evt, CONTRACT_ADDRESS)
    // hasKnownOperation SELECT ran but nothing else
    expect(queries.some((q) => q.sql.includes("INSERT"))).toBe(false)
  })

  it('inserts cancelled events only if the operation is known', async () => {
    const { client: c1, queries: q1 } = buildFakeClient({
      scheduledExists: true,
    })
    const evt: TimelockEventWithTimestamp = {
      blockTimestamp: 1783280000n,
      event: {
        kind: 'cancelled',
        operationId: OP_ID,
        blockNumber: 70945000n,
        txHash: '0xcafe' as `0x${string}`,
        logIndex: 0,
      },
    }
    await dispatchTimelockEvent(c1 as never, evt, CONTRACT_ADDRESS)
    expect(q1.some((q) => q.sql.includes("'cancelled'"))).toBe(true)

    const { client: c2, queries: q2 } = buildFakeClient({
      scheduledExists: false,
    })
    await dispatchTimelockEvent(c2 as never, evt, CONTRACT_ADDRESS)
    expect(q2.some((q) => q.sql.includes("'cancelled'"))).toBe(false)
  })
})

describe('advisory lock helpers', () => {
  it('uses a distinct advisory lock key from the neeru indexer', () => {
    // Sanity: the two workers must not contend
    expect(NEERU_TIMELOCK_ADVISORY_LOCK_KEY).toBe(7320041003n)
  })

  it('tryAcquireTimelockLock returns true when pg_try_advisory_lock returns true', async () => {
    const db = {
      query: async () => ({ rows: [{ ok: true }] }),
    }
    expect(await tryAcquireTimelockLock(db as never)).toBe(true)
  })

  it('tryAcquireTimelockLock returns false when the row is missing', async () => {
    const db = {
      query: async () => ({ rows: [] }),
    }
    expect(await tryAcquireTimelockLock(db as never)).toBe(false)
  })

  it('releaseTimelockLock issues the unlock query', async () => {
    const queries: string[] = []
    const db = {
      query: async (sql: string) => {
        queries.push(sql)
        return { rows: [] }
      },
    }
    await releaseTimelockLock(db as never)
    expect(queries[0]).toMatch(/pg_advisory_unlock/)
  })
})
