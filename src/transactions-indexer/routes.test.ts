import request from 'supertest'

const VALID_ADDRESS = '0x1111111111111111111111111111111111111111'
const COUNTERPARTY = '0x2222222222222222222222222222222222222222'

let dbMode: 'happy' | 'disabled' | 'noRows' = 'happy'
let queriedRows: Array<{ payload_json?: unknown; [k: string]: unknown }> = []

const mockQuery = jest.fn(async (sql: string, params?: readonly unknown[]) => {
  void params
  const normalized = sql.trim().toUpperCase()
  if (normalized.startsWith('INSERT INTO WATCHED_ADDRESS')) {
    return { rows: [] }
  }
  if (normalized.startsWith('SELECT PAYLOAD_JSON FROM CLASSIFIED_TX_CACHE')) {
    return { rows: [] }
  }
  if (normalized.startsWith('INSERT INTO CLASSIFIED_TX_CACHE')) {
    return { rows: [] }
  }
  if (normalized.startsWith('SELECT T.NETWORK_ID, T.TX_HASH')) {
    if (dbMode === 'noRows') return { rows: [] }
    return { rows: queriedRows }
  }
  if (normalized.startsWith('SELECT LOG_INDEX')) {
    return { rows: [] }
  }
  return { rows: [] }
})

jest.mock('../lib/db', () => ({
  getDb: () => {
    if (dbMode === 'disabled') return null
    return { query: mockQuery }
  },
}))

import { app } from '../app'

describe('POST /api/transactions/watch', () => {
  beforeEach(() => {
    mockQuery.mockClear()
    dbMode = 'happy'
  })

  it('rejects invalid address', async () => {
    const res = await request(app)
      .post('/api/transactions/watch')
      .send({ address: 'not-an-address' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid address' })
  })

  it('returns 503 when DB is not configured', async () => {
    dbMode = 'disabled'
    const res = await request(app)
      .post('/api/transactions/watch')
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(503)
  })

  it('inserts and returns ok+null backfill timestamp; address is normalized to lowercase', async () => {
    const mixedCase = '0x' + 'A'.repeat(40)
    const res = await request(app)
      .post('/api/transactions/watch')
      .send({ address: mixedCase })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, backfillStartedAt: null })
    expect(mockQuery).toHaveBeenCalled()
    const [sql, params] = mockQuery.mock.calls[0] ?? []
    expect(sql).toContain('INSERT INTO watched_address')
    expect(params).toEqual(['0x' + 'a'.repeat(40)])
  })
})

describe('GET /api/transactions/feed', () => {
  beforeEach(() => {
    mockQuery.mockClear()
    dbMode = 'noRows'
    queriedRows = []
  })

  it('rejects invalid address', async () => {
    const res = await request(app).get('/api/transactions/feed?address=nope')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid address' })
  })

  it('rejects invalid afterCursor', async () => {
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}&afterCursor=not-base64-json`,
    )
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid afterCursor' })
  })

  it('rejects unsupported networkIds with 400', async () => {
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}&networkIds=ethereum-mainnet`,
    )
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'unsupported networkId' })
  })

  it('accepts celo-mainnet networkId explicitly', async () => {
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}&networkIds=celo-mainnet`,
    )
    expect(res.status).toBe(200)
  })

  it('returns 503 when DB is not configured', async () => {
    dbMode = 'disabled'
    const res = await request(app).get(`/api/transactions/feed?address=${VALID_ADDRESS}`)
    expect(res.status).toBe(503)
  })

  it('returns empty feed when no transactions match', async () => {
    dbMode = 'noRows'
    const res = await request(app).get(`/api/transactions/feed?address=${VALID_ADDRESS}`)
    expect(res.status).toBe(200)
    expect(res.body.transactions).toEqual([])
    expect(res.body.pageInfo.hasNextPage).toBe(false)
    expect(res.body.pageInfo.endCursor).toBeNull()
  })

  it('classifies a native SEND from the DB row and returns it shaped for the wallet', async () => {
    dbMode = 'happy'
    queriedRows = [
      {
        network_id: 'celo-mainnet',
        tx_hash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
        block_number: '1000',
        block_timestamp: new Date(1_700_000_000_000),
        tx_index: 3,
        from_address: VALID_ADDRESS,
        to_address: COUNTERPARTY,
        value_wei: '5000000000000000000',
        status: 'success',
        gas_used: '21000',
        effective_gas_price: '5000000000',
        fee_currency: null,
        raw_input: '0x',
      },
    ]
    const res = await request(app).get(`/api/transactions/feed?address=${VALID_ADDRESS}`)
    expect(res.status).toBe(200)
    expect(res.body.transactions).toHaveLength(1)
    expect(res.body.transactions[0].type).toBe('SENT')
    expect(res.body.transactions[0].amount.tokenId).toBe(
      'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438',
    )
    expect(res.body.transactions[0].amount.value).toBe('5000000000000000000')
    expect(res.body.pageInfo.hasNextPage).toBe(false)
    expect(res.body.pageInfo.endCursor).not.toBeNull()
  })

  it('filters by includeTypes', async () => {
    dbMode = 'happy'
    queriedRows = [
      {
        network_id: 'celo-mainnet',
        tx_hash: '0xaaaa000000000000000000000000000000000000000000000000000000000002',
        block_number: '1001',
        block_timestamp: new Date(1_700_000_001_000),
        tx_index: 0,
        from_address: VALID_ADDRESS,
        to_address: COUNTERPARTY,
        value_wei: '1',
        status: 'success',
        gas_used: '21000',
        effective_gas_price: '5000000000',
        fee_currency: null,
        raw_input: '0x',
      },
    ]
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}&includeTypes=APPROVAL`,
    )
    expect(res.status).toBe(200)
    expect(res.body.transactions).toEqual([])
  })
})
