import express from 'express'
import request from 'supertest'

const mockGetTransactionReceipt = jest.fn()
const mockGetTransaction = jest.fn()
const mockCall = jest.fn()

jest.mock('../lib/celoClient', () => {
  const actual = jest.requireActual('../lib/celoClient')
  return {
    ...actual,
    getCeloPublicClient: () => ({
      getTransactionReceipt: mockGetTransactionReceipt,
      getTransaction: mockGetTransaction,
      call: mockCall,
    }),
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const router = require('./tx-status').default as express.Router
const app = express()
app.use(router)

const HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'

beforeEach(() => {
  mockGetTransactionReceipt.mockReset()
  mockGetTransaction.mockReset()
  mockCall.mockReset()
})

describe('GET /api/tx/status', () => {
  it('400s on missing hash', async () => {
    const res = await request(app).get('/api/tx/status')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid hash')
  })

  it('400s on malformed hash', async () => {
    const res = await request(app).get('/api/tx/status?hash=not-a-hash')
    expect(res.status).toBe(400)
  })

  it('400s on 0x-prefixed but wrong-length hash', async () => {
    const res = await request(app).get('/api/tx/status?hash=0xabc')
    expect(res.status).toBe(400)
  })

  it('returns pending when the RPC says receipt not found', async () => {
    mockGetTransactionReceipt.mockRejectedValue(
      new Error('Transaction receipt with hash "..." could not be found.'),
    )
    const res = await request(app).get(`/api/tx/status?hash=${HASH}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'pending' })
  })

  it('502s when the RPC surfaces a non-recoverable error', async () => {
    mockGetTransactionReceipt.mockRejectedValue(new Error('rpc timeout'))
    const res = await request(app).get(`/api/tx/status?hash=${HASH}`)
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('rpc unavailable')
  })

  it('returns success when the tx mined with status=success', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 72280747n,
      transactionHash: HASH,
    })
    const res = await request(app).get(`/api/tx/status?hash=${HASH}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'success',
      blockNumber: '72280747',
      transactionHash: HASH,
    })
  })

  it('returns reverted with known reason when replay surfaces a known selector', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 72280747n,
      transactionHash: HASH,
    })
    mockGetTransaction.mockResolvedValue({
      from: '0xf01365c382f29861ec27e2ad332f0b94171f7f93',
      to: '0x988af5977201a0e988f2c75ea952532f6beb5082',
      input: '0xa126d6010000000000000000000000000000000000000000000000000000000000000001',
    })
    // Replay throws with a viem-shaped RawContractError carrying `.data`.
    mockCall.mockRejectedValue(
      Object.assign(new Error('execution reverted'), {
        cause: { data: '0x2648b779' },
      }),
    )
    const res = await request(app).get(`/api/tx/status?hash=${HASH}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'reverted',
      blockNumber: '72280747',
      transactionHash: HASH,
      revert: { selector: '0x2648b779', reason: 'INTEREST_POOL_LOW' },
    })
  })

  it('returns reverted with UNKNOWN when the selector is not mapped', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 72280747n,
      transactionHash: HASH,
    })
    mockGetTransaction.mockResolvedValue({
      from: '0xf01365c382f29861ec27e2ad332f0b94171f7f93',
      to: '0x988af5977201a0e988f2c75ea952532f6beb5082',
      input: '0xdeadbeef',
    })
    mockCall.mockRejectedValue(
      Object.assign(new Error('execution reverted'), {
        cause: { data: '0xcafef00d' },
      }),
    )
    const res = await request(app).get(`/api/tx/status?hash=${HASH}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('reverted')
    expect(res.body.revert).toEqual({
      selector: '0xcafef00d',
      reason: 'UNKNOWN',
    })
  })

  it('returns reverted with selector:null when replay succeeds at prior block', async () => {
    // Some reverts only trigger under the exact state at the mining block
    // (e.g. reentrancy state, concurrent writes). Replay at N-1 succeeds
    // but the receipt still shows reverted. Wallet gets status:reverted
    // with no selector so it renders a generic error.
    mockGetTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 72280747n,
      transactionHash: HASH,
    })
    mockGetTransaction.mockResolvedValue({
      from: '0xf01365c382f29861ec27e2ad332f0b94171f7f93',
      to: '0x988af5977201a0e988f2c75ea952532f6beb5082',
      input: '0xa126d601',
    })
    mockCall.mockResolvedValue({ data: '0x' })
    const res = await request(app).get(`/api/tx/status?hash=${HASH}`)
    expect(res.body.status).toBe('reverted')
    expect(res.body.revert).toEqual({ selector: null, reason: 'UNKNOWN' })
  })

  it('returns reverted with selector:null when tx has no input (native transfer that reverted)', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 72280747n,
      transactionHash: HASH,
    })
    mockGetTransaction.mockResolvedValue({
      from: '0xf01365c382f29861ec27e2ad332f0b94171f7f93',
      to: '0x000000000000000000000000000000000000dead',
      input: '0x',
    })
    const res = await request(app).get(`/api/tx/status?hash=${HASH}`)
    expect(res.body.status).toBe('reverted')
    expect(res.body.revert.selector).toBeNull()
    // Since we short-circuit before calling, replay was never attempted.
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('lowercases the hash before RPC lookup', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 1n,
      transactionHash: HASH,
    })
    const upper = '0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890'
    await request(app).get(`/api/tx/status?hash=${upper}`)
    expect(mockGetTransactionReceipt).toHaveBeenCalledWith({ hash: upper.toLowerCase() })
  })
})
