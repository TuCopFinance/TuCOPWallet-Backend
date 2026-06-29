import request from 'supertest'
import { app } from '../app'
import * as blockscout from '../lib/blockscout'

jest.mock('../lib/blockscout')
jest.mock('../lib/redis', () => ({
  getRedis: () => null,
}))

const mockBlockscoutGet = blockscout.blockscoutGet as jest.MockedFunction<
  typeof blockscout.blockscoutGet
>

const VALID_HASH =
  '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
// Synthetic test address; do not use a real-looking prefix.
const VALID_ADDRESS = '0x3333333333333333333333333333333333333333'

describe('blockscout proxy', () => {
  beforeEach(() => {
    mockBlockscoutGet.mockReset()
  })

  describe('GET /api/v2/transactions/:hash', () => {
    it('passes through the upstream JSON on a valid hash', async () => {
      mockBlockscoutGet.mockResolvedValueOnce({ hash: VALID_HASH, status: 'ok' })

      const res = await request(app).get(`/api/v2/transactions/${VALID_HASH}`)

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ hash: VALID_HASH, status: 'ok' })
      expect(mockBlockscoutGet).toHaveBeenCalledWith({
        path: `/api/v2/transactions/${VALID_HASH}`,
        query: {},
      })
    })

    it('rejects an invalid hash with 400', async () => {
      const res = await request(app).get('/api/v2/transactions/0xnothex')
      expect(res.status).toBe(400)
      expect(mockBlockscoutGet).not.toHaveBeenCalled()
    })

    it('returns 502 when upstream errors', async () => {
      mockBlockscoutGet.mockRejectedValueOnce(new Error('blockscout down'))
      const res = await request(app).get(`/api/v2/transactions/${VALID_HASH}`)
      expect(res.status).toBe(502)
    })
  })

  describe('GET /api/v2/addresses/:address/transactions', () => {
    it('passes through on a valid address', async () => {
      mockBlockscoutGet.mockResolvedValueOnce({ items: [] })

      const res = await request(app).get(
        `/api/v2/addresses/${VALID_ADDRESS}/transactions`,
      )

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ items: [] })
      expect(mockBlockscoutGet).toHaveBeenCalledWith({
        path: `/api/v2/addresses/${VALID_ADDRESS}/transactions`,
        query: {},
      })
    })

    it('forwards filter/cursor query params to upstream', async () => {
      mockBlockscoutGet.mockResolvedValueOnce({ items: [] })

      await request(app).get(
        `/api/v2/addresses/${VALID_ADDRESS}/transactions?filter=to&block_number=123`,
      )

      expect(mockBlockscoutGet).toHaveBeenCalledWith({
        path: `/api/v2/addresses/${VALID_ADDRESS}/transactions`,
        query: { filter: 'to', block_number: '123' },
      })
    })

    it('strips reserved apikey query param so attackers cannot override the server key', async () => {
      mockBlockscoutGet.mockResolvedValueOnce({ items: [] })

      await request(app).get(
        `/api/v2/addresses/${VALID_ADDRESS}/transactions?apikey=evil&filter=to`,
      )

      const call = mockBlockscoutGet.mock.calls[0]?.[0]
      expect(call?.query).not.toHaveProperty('apikey')
      expect(call?.query).toMatchObject({ filter: 'to' })
    })

    it('rejects invalid address with 400', async () => {
      const res = await request(app).get('/api/v2/addresses/0xnope/transactions')
      expect(res.status).toBe(400)
      expect(mockBlockscoutGet).not.toHaveBeenCalled()
    })
  })

  describe('GET /api/v2/addresses/:address/token-transfers', () => {
    it('passes through on a valid address', async () => {
      mockBlockscoutGet.mockResolvedValueOnce({ items: [{ token: 'USDC' }] })

      const res = await request(app).get(
        `/api/v2/addresses/${VALID_ADDRESS}/token-transfers`,
      )

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ items: [{ token: 'USDC' }] })
      expect(mockBlockscoutGet).toHaveBeenCalledWith({
        path: `/api/v2/addresses/${VALID_ADDRESS}/token-transfers`,
        query: {},
      })
    })

    it('rejects invalid address with 400', async () => {
      const res = await request(app).get(
        '/api/v2/addresses/0xshort/token-transfers',
      )
      expect(res.status).toBe(400)
      expect(mockBlockscoutGet).not.toHaveBeenCalled()
    })
  })
})
