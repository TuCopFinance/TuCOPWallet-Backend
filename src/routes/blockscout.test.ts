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
const VALID_ADDRESS = '0xa203bb4b3eba27ad3a5e3da6b8d6b8d6b8d6b8d6'

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
      expect(mockBlockscoutGet).toHaveBeenCalledWith(`/api/v2/transactions/${VALID_HASH}`)
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
      expect(mockBlockscoutGet).toHaveBeenCalledWith(
        `/api/v2/addresses/${VALID_ADDRESS}/transactions`,
      )
    })

    it('forwards filter/cursor query params to upstream', async () => {
      mockBlockscoutGet.mockResolvedValueOnce({ items: [] })

      await request(app).get(
        `/api/v2/addresses/${VALID_ADDRESS}/transactions?filter=to&block_number=123`,
      )

      expect(mockBlockscoutGet).toHaveBeenCalledWith(
        `/api/v2/addresses/${VALID_ADDRESS}/transactions?filter=to&block_number=123`,
      )
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
      expect(mockBlockscoutGet).toHaveBeenCalledWith(
        `/api/v2/addresses/${VALID_ADDRESS}/token-transfers`,
      )
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
