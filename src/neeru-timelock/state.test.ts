import {
  ensureTimelockStateSeed,
  getTimelockState,
  recordTimelockError,
  setLastScannedBlock,
} from './state'

interface RecordedQuery {
  sql: string
  params: readonly unknown[]
}

function buildFakeDb(opts: {
  stateRow?: {
    id: number
    last_scanned_block: string
    last_scan_at: Date
    last_error: string | null
    last_error_at: Date | null
  } | null
} = {}) {
  const queries: RecordedQuery[] = []
  const stateRow = opts.stateRow === undefined
    ? {
        id: 1,
        last_scanned_block: '70876543',
        last_scan_at: new Date('2026-07-05T00:00:00Z'),
        last_error: null,
        last_error_at: null,
      }
    : opts.stateRow

  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      return { rows: [] }
    },
    release: jest.fn(),
  }

  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const normalised = sql.trim().toUpperCase()
      if (normalised.startsWith('SELECT')) {
        return { rows: stateRow ? [stateRow] : [] }
      }
      return { rows: [] }
    },
    connect: async () => client,
  }
  return { db, client, queries }
}

describe('getTimelockState', () => {
  it('returns the singleton row parsed to bigints', async () => {
    const { db } = buildFakeDb()
    const state = await getTimelockState(db as never)
    expect(state).not.toBeNull()
    expect(state?.id).toBe(1)
    expect(state?.lastScannedBlock).toBe(70876543n)
    expect(state?.lastError).toBeNull()
  })

  it('returns null when the singleton row is missing', async () => {
    const { db } = buildFakeDb({ stateRow: null })
    expect(await getTimelockState(db as never)).toBeNull()
  })
})

describe('ensureTimelockStateSeed', () => {
  it('inserts the seed with ON CONFLICT DO NOTHING', async () => {
    const { db, queries } = buildFakeDb()
    await ensureTimelockStateSeed(db as never, 70876543n)
    const insert = queries.find((q) =>
      q.sql.trim().toUpperCase().startsWith('INSERT INTO NEERU_TIMELOCK_STATE'),
    )
    expect(insert).toBeDefined()
    expect(insert?.sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    expect(insert?.params).toEqual(['70876543'])
  })
})

describe('setLastScannedBlock', () => {
  it('updates the cursor row on the supplied client', async () => {
    const { client, queries } = buildFakeDb()
    await setLastScannedBlock(client as never, 70942000n)
    const update = queries.find((q) =>
      q.sql.trim().toUpperCase().startsWith('UPDATE NEERU_TIMELOCK_STATE'),
    )
    expect(update).toBeDefined()
    expect(update?.params).toEqual(['70942000'])
  })
})

describe('recordTimelockError', () => {
  it('writes the message to last_error', async () => {
    const { db, queries } = buildFakeDb()
    await recordTimelockError(db as never, 'rpc chain exhausted')
    const update = queries.find((q) =>
      q.sql.trim().toUpperCase().startsWith('UPDATE NEERU_TIMELOCK_STATE'),
    )
    expect(update).toBeDefined()
    expect(update?.params).toEqual(['rpc chain exhausted'])
  })

  it('swallows DB failures so the worker never crashes on error reporting', async () => {
    const failingDb = {
      query: async () => {
        throw new Error('connection refused')
      },
      connect: async () => {
        throw new Error('not used')
      },
    }
    await expect(
      recordTimelockError(failingDb as never, 'anything'),
    ).resolves.toBeUndefined()
  })
})
