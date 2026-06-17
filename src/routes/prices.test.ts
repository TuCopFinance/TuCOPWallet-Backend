import request from 'supertest'
import { app } from '../app'
import * as cmc from '../lib/coinmarketcap'

jest.mock('../lib/coinmarketcap')
jest.mock('../lib/redis', () => ({
  getRedis: () => null,
}))

const mockGetXautPriceUsd = cmc.getXautPriceUsd as jest.MockedFunction<
  typeof cmc.getXautPriceUsd
>

describe('GET /api/prices/xaut', () => {
  beforeEach(() => {
    mockGetXautPriceUsd.mockReset()
  })

  it('returns USD price with required shape', async () => {
    mockGetXautPriceUsd.mockResolvedValueOnce({
      priceUsd: 3421.5,
      asOf: '2026-06-16T12:00:00.000Z',
    })

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      symbol: 'XAUT',
      vs: 'usd',
      priceUsd: 3421.5,
      asOf: '2026-06-16T12:00:00.000Z',
    })
  })

  it('defaults to usd when vs is omitted', async () => {
    mockGetXautPriceUsd.mockResolvedValueOnce({
      priceUsd: 3500,
      asOf: '2026-06-16T12:00:00.000Z',
    })

    const res = await request(app).get('/api/prices/xaut')

    expect(res.status).toBe(200)
    expect(res.body.vs).toBe('usd')
  })

  it('rejects non-usd vs param', async () => {
    const res = await request(app).get('/api/prices/xaut?vs=cop')
    expect(res.status).toBe(400)
    expect(mockGetXautPriceUsd).not.toHaveBeenCalled()
  })

  it('returns 502 when upstream price feed fails', async () => {
    mockGetXautPriceUsd.mockRejectedValueOnce(new Error('CMC unreachable'))

    const res = await request(app).get('/api/prices/xaut?vs=usd')

    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ error: expect.any(String) })
  })
})
