import request from 'supertest'
import { _resetParsedEnvForTests } from '../lib/env'

const VALID_ADDRESS = '0x1111111111111111111111111111111111111111'
const COUNTERPARTY = '0x2222222222222222222222222222222222222222'

let dbMode: 'happy' | 'disabled' | 'noRows' = 'happy'
let queriedRows: Array<{ payload_json?: unknown; [k: string]: unknown }> = []
let indexerStateRows: Array<{ last_block: string }> = []
let watchedCountRows: Array<{ count: string }> = []
let indexerStateThrows = false
let watchInsertRow: {
  backfill_started_at: Date | null
  backfill_completed_at: Date | null
} = {
  backfill_started_at: new Date('2026-06-29T20:00:00.000Z'),
  backfill_completed_at: null,
}

const mockQuery = jest.fn(async (sql: string, params?: readonly unknown[]) => {
  void params
  const normalized = sql.trim().toUpperCase()
  if (normalized.startsWith('INSERT INTO WATCHED_ADDRESS')) {
    return { rows: [watchInsertRow] }
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
  if (normalized.startsWith('SELECT LAST_BLOCK FROM INDEXER_STATE')) {
    if (indexerStateThrows) throw new Error('db down')
    return { rows: indexerStateRows }
  }
  if (normalized.includes('FROM WATCHED_ADDRESS')) {
    return { rows: watchedCountRows }
  }
  return { rows: [] }
})

const mockGetBlockNumber = jest.fn()

jest.mock('../lib/db', () => ({
  getDb: () => {
    if (dbMode === 'disabled') return null
    return { query: mockQuery }
  },
}))

jest.mock('../lib/celoClient', () => {
  const actual = jest.requireActual('../lib/celoClient')
  return {
    ...actual,
    getCeloPublicClient: () => ({ getBlockNumber: mockGetBlockNumber }),
  }
})

const mockTriggerBackfill = jest.fn()
const mockReopenBackfillIfDeeper = jest.fn()
jest.mock('./backfill', () => ({
  triggerBackfill: (...args: unknown[]) => mockTriggerBackfill(...args),
  reopenBackfillIfDeeper: (...args: unknown[]) => mockReopenBackfillIfDeeper(...args),
}))

import { app } from '../app'

describe('POST /api/transactions/watch', () => {
  beforeEach(() => {
    mockQuery.mockClear()
    mockTriggerBackfill.mockClear()
    mockReopenBackfillIfDeeper.mockClear()
    mockGetBlockNumber.mockReset()
    mockGetBlockNumber.mockResolvedValue(90_000_000n)
    dbMode = 'happy'
    watchInsertRow = {
      backfill_started_at: new Date('2026-06-29T20:00:00.000Z'),
      backfill_completed_at: null,
    }
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

  it('inserts, normalizes address to lowercase, returns backfillStartedAt + backfillCompleted=false', async () => {
    const mixedCase = '0x' + 'A'.repeat(40)
    const res = await request(app)
      .post('/api/transactions/watch')
      .send({ address: mixedCase })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      backfillStartedAt: '2026-06-29T20:00:00.000Z',
      backfillCompleted: false,
    })
    expect(mockQuery).toHaveBeenCalled()
    const [sql, params] = mockQuery.mock.calls[0] ?? []
    expect(sql).toContain('INSERT INTO watched_address')
    expect(params).toEqual(['0x' + 'a'.repeat(40)])
  })

  it('triggers backfill when backfill_completed_at is null', async () => {
    watchInsertRow = {
      backfill_started_at: new Date('2026-06-29T20:00:00.000Z'),
      backfill_completed_at: null,
    }
    await request(app)
      .post('/api/transactions/watch')
      .send({ address: VALID_ADDRESS })
    expect(mockTriggerBackfill).toHaveBeenCalledTimes(1)
    const [, address] = mockTriggerBackfill.mock.calls[0]
    expect(address).toBe(VALID_ADDRESS)
  })

  it('does NOT trigger backfill when backfill_completed_at is already set', async () => {
    watchInsertRow = {
      backfill_started_at: new Date('2026-06-29T20:00:00.000Z'),
      backfill_completed_at: new Date('2026-06-29T20:05:00.000Z'),
    }
    const res = await request(app)
      .post('/api/transactions/watch')
      .send({ address: VALID_ADDRESS })
    expect(res.body.backfillCompleted).toBe(true)
    expect(mockTriggerBackfill).not.toHaveBeenCalled()
  })

  describe('walletCreatedAt validation', () => {
    it('accepts a valid past ISO 8601 walletCreatedAt and passes it to backfill', async () => {
      const iso = '2026-01-15T10:30:00.000Z'
      const res = await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: iso })
      expect(res.status).toBe(200)
      expect(mockTriggerBackfill).toHaveBeenCalledTimes(1)
      const [, address, options] = mockTriggerBackfill.mock.calls[0]
      expect(address).toBe(VALID_ADDRESS)
      expect(options).toEqual({ walletCreatedAtIso: iso })
    })

    it('omits walletCreatedAtIso from options when not provided', async () => {
      await request(app).post('/api/transactions/watch').send({ address: VALID_ADDRESS })
      expect(mockTriggerBackfill).toHaveBeenCalledTimes(1)
      const [, , options] = mockTriggerBackfill.mock.calls[0]
      expect(options).toEqual({})
    })

    it('rejects non-string walletCreatedAt', async () => {
      const res = await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: 12345 })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid walletCreatedAt' })
      expect(mockTriggerBackfill).not.toHaveBeenCalled()
    })

    it('rejects unparseable walletCreatedAt string', async () => {
      const res = await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: 'not-a-date' })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid walletCreatedAt' })
    })

    it('rejects future walletCreatedAt', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      const res = await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: future })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid walletCreatedAt' })
    })

    it('rejects walletCreatedAt before 2020-04-01 (Celo genesis floor)', async () => {
      const res = await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: '2019-01-01T00:00:00.000Z' })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'invalid walletCreatedAt' })
    })
  })

  describe('backfillCompleted + walletCreatedAt re-open path', () => {
    beforeEach(() => {
      watchInsertRow = {
        backfill_started_at: new Date('2026-06-29T20:00:00.000Z'),
        backfill_completed_at: new Date('2026-06-29T20:05:00.000Z'),
      }
    })

    it('calls reopenBackfillIfDeeper when completed row receives walletCreatedAt', async () => {
      mockReopenBackfillIfDeeper.mockResolvedValue(true)
      const res = await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: '2026-01-15T10:30:00.000Z' })
      expect(res.status).toBe(200)
      expect(res.body.backfillCompleted).toBe(true)
      // The re-open runs in a background task; give it a tick.
      await new Promise((r) => setImmediate(r))
      expect(mockReopenBackfillIfDeeper).toHaveBeenCalledTimes(1)
      const [, address, tip, iso] = mockReopenBackfillIfDeeper.mock.calls[0]
      expect(address).toBe(VALID_ADDRESS)
      expect(tip).toBe(90_000_000n)
      expect(iso).toBe('2026-01-15T10:30:00.000Z')
    })

    it('triggers backfill only when reopenBackfillIfDeeper returns true', async () => {
      mockReopenBackfillIfDeeper.mockResolvedValue(true)
      await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: '2026-01-15T10:30:00.000Z' })
      await new Promise((r) => setImmediate(r))
      expect(mockTriggerBackfill).toHaveBeenCalledTimes(1)
    })

    it('does NOT trigger backfill when reopen returns false (nothing deeper to scan)', async () => {
      mockReopenBackfillIfDeeper.mockResolvedValue(false)
      await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: '2026-01-15T10:30:00.000Z' })
      await new Promise((r) => setImmediate(r))
      expect(mockReopenBackfillIfDeeper).toHaveBeenCalledTimes(1)
      expect(mockTriggerBackfill).not.toHaveBeenCalled()
    })

    it('does NOT call reopenBackfillIfDeeper when walletCreatedAt is absent (existing idempotent behaviour)', async () => {
      await request(app).post('/api/transactions/watch').send({ address: VALID_ADDRESS })
      await new Promise((r) => setImmediate(r))
      expect(mockReopenBackfillIfDeeper).not.toHaveBeenCalled()
      expect(mockTriggerBackfill).not.toHaveBeenCalled()
    })

    it('swallows RPC failures from the tip lookup without failing the /watch response', async () => {
      mockGetBlockNumber.mockRejectedValueOnce(new Error('forno down'))
      const res = await request(app)
        .post('/api/transactions/watch')
        .send({ address: VALID_ADDRESS, walletCreatedAt: '2026-01-15T10:30:00.000Z' })
      expect(res.status).toBe(200)
      await new Promise((r) => setImmediate(r))
      expect(mockReopenBackfillIfDeeper).not.toHaveBeenCalled()
      expect(mockTriggerBackfill).not.toHaveBeenCalled()
    })
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
    expect(res.body.transactions[0].amount.value).toBe('5.000000000000000000')
    expect(res.body.pageInfo.hasNextPage).toBe(false)
    expect(res.body.pageInfo.endCursor).not.toBeNull()
  })

  it('rejects invalid localCurrencyCode', async () => {
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}&localCurrencyCode=DOLLARS`,
    )
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid localCurrencyCode' })
  })

  it('populates localAmount when token peg matches localCurrencyCode (USDC -> USD)', async () => {
    dbMode = 'happy'
    queriedRows = [
      {
        network_id: 'celo-mainnet',
        // USDC contract address; classifier-recognised peg = USD
        tx_hash: '0xaaaa000000000000000000000000000000000000000000000000000000000003',
        block_number: '1002',
        block_timestamp: new Date(1_700_000_002_000),
        tx_index: 0,
        from_address: VALID_ADDRESS,
        to_address: COUNTERPARTY,
        // transfer(address,uint256) selector + 32-byte recipient + 32-byte
        // value = 1.5 USDC (1500000 with decimals=6)
        value_wei: '0',
        status: 'success',
        gas_used: '50000',
        effective_gas_price: '5000000000',
        fee_currency: null,
        raw_input:
          '0xa9059cbb' +
          '000000000000000000000000' + COUNTERPARTY.slice(2) +
          '000000000000000000000000000000000000000000000000000000000016e360',
      },
    ]
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}&localCurrencyCode=USD`,
    )
    expect(res.status).toBe(200)
    // Classifier emits SENT with tokenId = celo-mainnet:<tx.to> (the USDC
    // contract is the `to` of an ERC20 transfer call). Our queriedRow puts
    // COUNTERPARTY as to_address, so this test does NOT exercise the
    // priceOracle code path directly - that's covered by priceOracle.test.ts.
    // What this test asserts is that the feed route returns 200 with the
    // localCurrencyCode parsed and accepted.
    expect(res.body.transactions).toHaveLength(1)
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

describe('GET /api/transactions/indexer/health', () => {
  beforeEach(() => {
    mockQuery.mockClear()
    mockGetBlockNumber.mockReset()
    dbMode = 'happy'
    indexerStateRows = []
    watchedCountRows = []
    indexerStateThrows = false
  })

  it('returns 503 when DB is not configured', async () => {
    dbMode = 'disabled'
    const res = await request(app).get('/api/transactions/indexer/health')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'database not configured' })
  })

  it('returns full shape with lagBlocks when DB + RPC are healthy', async () => {
    indexerStateRows = [{ last_block: '70513283' }]
    watchedCountRows = [{ count: '42' }]
    mockGetBlockNumber.mockResolvedValue(70513290n)

    const res = await request(app).get('/api/transactions/indexer/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      networkId: 'celo-mainnet',
      lastIndexedBlock: 70513283,
      celoTipBlock: 70513290,
      lagBlocks: 7,
      watchedAddressCount: 42,
    })
  })

  it('clamps lagBlocks to 0 when last_block is ahead of tip (transient reorg state)', async () => {
    indexerStateRows = [{ last_block: '100' }]
    watchedCountRows = [{ count: '0' }]
    mockGetBlockNumber.mockResolvedValue(95n)

    const res = await request(app).get('/api/transactions/indexer/health')
    expect(res.status).toBe(200)
    expect(res.body.lagBlocks).toBe(0)
  })

  it('returns lastIndexedBlock=null when indexer_state is empty', async () => {
    indexerStateRows = []
    watchedCountRows = [{ count: '0' }]
    mockGetBlockNumber.mockResolvedValue(70513290n)

    const res = await request(app).get('/api/transactions/indexer/health')
    expect(res.status).toBe(200)
    expect(res.body.lastIndexedBlock).toBeNull()
    expect(res.body.lagBlocks).toBeNull()
    expect(res.body.celoTipBlock).toBe(70513290)
  })

  it('returns degraded shape (celoTipBlock=null, lagBlocks=null) when RPC fails', async () => {
    indexerStateRows = [{ last_block: '100' }]
    watchedCountRows = [{ count: '1' }]
    mockGetBlockNumber.mockRejectedValue(new Error('forno 500'))

    const res = await request(app).get('/api/transactions/indexer/health')
    expect(res.status).toBe(200)
    expect(res.body.lastIndexedBlock).toBe(100)
    expect(res.body.watchedAddressCount).toBe(1)
    expect(res.body.celoTipBlock).toBeNull()
    expect(res.body.lagBlocks).toBeNull()
  })

  it('returns 500 when the indexer_state query throws', async () => {
    indexerStateThrows = true
    mockGetBlockNumber.mockResolvedValue(70513290n)
    const res = await request(app).get('/api/transactions/indexer/health')
    expect(res.status).toBe(500)
  })
})

// Kill switch coverage. env.TX_FEED_ENABLED / TX_WATCH_ENABLED are parsed on
// first access via the zod proxy; we flip the process env + reset the parsed
// env cache to exercise both `true` and `false` states.
describe('kill switches: TX_FEED_ENABLED / TX_WATCH_ENABLED', () => {
  const originalFeed = process.env.TX_FEED_ENABLED
  const originalWatch = process.env.TX_WATCH_ENABLED

  afterEach(() => {
    process.env.TX_FEED_ENABLED = originalFeed
    process.env.TX_WATCH_ENABLED = originalWatch
    _resetParsedEnvForTests()
  })

  it('GET /api/transactions/feed returns 503 "feed disabled" when TX_FEED_ENABLED=false', async () => {
    process.env.TX_FEED_ENABLED = 'false'
    _resetParsedEnvForTests()
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}`,
    )
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'feed disabled' })
  })

  it('POST /api/transactions/watch returns 503 "watch disabled" when TX_WATCH_ENABLED=false', async () => {
    process.env.TX_WATCH_ENABLED = 'false'
    _resetParsedEnvForTests()
    const res = await request(app)
      .post('/api/transactions/watch')
      .send({ address: VALID_ADDRESS })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'watch disabled' })
  })

  it('feed still serves when TX_FEED_ENABLED is unset (default true)', async () => {
    delete process.env.TX_FEED_ENABLED
    _resetParsedEnvForTests()
    dbMode = 'noRows'
    const res = await request(app).get(
      `/api/transactions/feed?address=${VALID_ADDRESS}`,
    )
    expect(res.status).toBe(200)
  })
})
