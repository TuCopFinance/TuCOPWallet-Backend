// Route integration test: mount the router on a bare express app and hit
// the endpoint with a fake DB backing. Verifies status grouping + shape.

process.env.NEERU_TIMELOCK_ADDRESS =
  '0xe8358c9cfa4f7af8acd6ff86e012d828527497bf'
process.env.NEERU_CONTRACT_ADDRESS =
  '0x988af5977201a0e988f2c75ea952532f6beb5082'
process.env.NEERU_TIMELOCK_GENESIS_BLOCK = '1234568'
process.env.NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0 =
  '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca'
process.env.NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0 =
  '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58'
process.env.NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0 =
  '0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70'

// Mock getDb before the router imports it via state.ts + routes.ts.
type FakeRow = Record<string, unknown>
const dbRows: {
  state: FakeRow | null
  events: FakeRow[]
} = {
  state: {
    id: 1,
    last_scanned_block: '1234700',
    last_scan_at: new Date('2026-07-05T12:00:00Z'),
    last_error: null,
    last_error_at: null,
  },
  events: [],
}

jest.mock('../lib/db', () => ({
  getDb: () => ({
    query: async (sql: string) => {
      const norm = sql.trim().toUpperCase()
      if (norm.startsWith('SELECT ID,')) {
        return { rows: dbRows.state ? [dbRows.state] : [] }
      }
      if (norm.includes('FROM NEERU_UPGRADE_EVENTS')) {
        return { rows: dbRows.events }
      }
      return { rows: [] }
    },
  }),
}))

import express from 'express'
import request from 'supertest'
import { neeruTimelockRouter } from './routes'

const OP_1 = '0x' + 'aa'.repeat(32)
const OP_2 = '0x' + 'bb'.repeat(32)
const OP_3 = '0x' + 'cc'.repeat(32)

function makeApp() {
  const app = express()
  app.use(neeruTimelockRouter)
  return app
}

describe('GET /api/earn/neeru/upgrade-schedule', () => {
  beforeEach(() => {
    dbRows.state = {
      id: 1,
      last_scanned_block: '1234700',
      last_scan_at: new Date('2026-07-05T12:00:00Z'),
      last_error: null,
      last_error_at: null,
    }
    dbRows.events = []
  })

  it('returns empty groups when no events exist', async () => {
    const res = await request(makeApp())
      .get('/api/earn/neeru/upgrade-schedule')
      .expect(200)
    expect(res.body.data.pending).toEqual([])
    expect(res.body.data.executed).toEqual([])
    expect(res.body.data.cancelled).toEqual([])
    expect(res.body.data.lastSyncedBlock).toBe('1234700')
    expect(res.body.data.lastError).toBeNull()
  })

  it('groups scheduled + executed pairs as executed', async () => {
    dbRows.events = [
      {
        event_id: '1',
        kind: 'scheduled',
        operation_id: OP_1,
        target: '0x988af5977201a0e988f2c75ea952532f6beb5082',
        value: '0',
        calldata: '0xdead',
        predecessor: `0x${'00'.repeat(32)}`,
        delay: '172800',
        ready_ts: '1783432800',
        block_number: '1234700',
        block_timestamp: '1783260000',
        tx_hash: '0xaaa',
        log_index: 0,
        created_at: new Date(),
      },
      {
        event_id: '2',
        kind: 'executed',
        operation_id: OP_1,
        target: '0x988af5977201a0e988f2c75ea952532f6beb5082',
        value: '0',
        calldata: '0xdead',
        predecessor: null,
        delay: null,
        ready_ts: null,
        block_number: '1234900',
        block_timestamp: '1783300000',
        tx_hash: '0xbbb',
        log_index: 0,
        created_at: new Date(),
      },
    ]
    const res = await request(makeApp())
      .get('/api/earn/neeru/upgrade-schedule')
      .expect(200)
    expect(res.body.data.pending).toEqual([])
    expect(res.body.data.executed).toHaveLength(1)
    expect(res.body.data.executed[0].operationId).toBe(OP_1)
    expect(res.body.data.executed[0].status).toBe('executed')
    expect(res.body.data.executed[0].executed.txHash).toBe('0xbbb')
  })

  it('groups scheduled + cancelled pairs as cancelled', async () => {
    dbRows.events = [
      {
        event_id: '1',
        kind: 'scheduled',
        operation_id: OP_2,
        target: '0x988af5977201a0e988f2c75ea952532f6beb5082',
        value: '0',
        calldata: '0xdead',
        predecessor: `0x${'00'.repeat(32)}`,
        delay: '172800',
        ready_ts: '1783432800',
        block_number: '1234700',
        block_timestamp: '1783260000',
        tx_hash: '0xaaa',
        log_index: 0,
        created_at: new Date(),
      },
      {
        event_id: '2',
        kind: 'cancelled',
        operation_id: OP_2,
        target: null,
        value: null,
        calldata: null,
        predecessor: null,
        delay: null,
        ready_ts: null,
        block_number: '1234800',
        block_timestamp: '1783280000',
        tx_hash: '0xccc',
        log_index: 0,
        created_at: new Date(),
      },
    ]
    const res = await request(makeApp())
      .get('/api/earn/neeru/upgrade-schedule')
      .expect(200)
    expect(res.body.data.pending).toEqual([])
    expect(res.body.data.cancelled).toHaveLength(1)
    expect(res.body.data.cancelled[0].operationId).toBe(OP_2)
    expect(res.body.data.cancelled[0].cancelled.txHash).toBe('0xccc')
  })

  it('lists scheduled-only operations as pending', async () => {
    dbRows.events = [
      {
        event_id: '1',
        kind: 'scheduled',
        operation_id: OP_3,
        target: '0x988af5977201a0e988f2c75ea952532f6beb5082',
        value: '0',
        calldata: '0xdead',
        predecessor: `0x${'00'.repeat(32)}`,
        delay: '172800',
        ready_ts: '1783432800',
        block_number: '1234700',
        block_timestamp: '1783260000',
        tx_hash: '0xaaa',
        log_index: 0,
        created_at: new Date(),
      },
    ]
    const res = await request(makeApp())
      .get('/api/earn/neeru/upgrade-schedule')
      .expect(200)
    expect(res.body.data.pending).toHaveLength(1)
    expect(res.body.data.pending[0].operationId).toBe(OP_3)
    expect(res.body.data.pending[0].scheduled.delay).toBe('172800')
    expect(res.body.data.pending[0].scheduled.readyTs).toBe('1783432800')
    expect(res.body.data.executed).toEqual([])
    expect(res.body.data.cancelled).toEqual([])
  })
})
