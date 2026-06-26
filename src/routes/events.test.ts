import request from 'supertest'
import { app } from '../app'

jest.mock('../lib/redis', () => ({ getRedis: () => null }))

const WHITELISTED = '0x947c6db1569edc9fd37b017b791ca0f008ab4946'
const NOT_WHITELISTED = '0x1111111111111111111111111111111111111111'

describe('GET /events', () => {
  const ORIGINAL_ENV = { ...process.env }
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    fetchSpy = jest.spyOn(global, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('returns 503 when ETHERSCAN_API_KEY is not set', async () => {
    delete process.env.ETHERSCAN_API_KEY

    const res = await request(app).get(`/events?address=${WHITELISTED}`)

    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when address is not a 0x-prefixed 40-hex string', async () => {
    process.env.ETHERSCAN_API_KEY = 'test-key'

    const res = await request(app).get('/events?address=0xnothex')

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 403 when address is well-formed but not whitelisted', async () => {
    process.env.ETHERSCAN_API_KEY = 'test-key'

    const res = await request(app).get(`/events?address=${NOT_WHITELISTED}`)

    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns events from upstream on a whitelisted address', async () => {
    process.env.ETHERSCAN_API_KEY = 'test-key'
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: '1', message: 'OK', result: [{ topics: ['0xdead'] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const res = await request(app).get(`/events?address=${WHITELISTED}`)

    expect(res.status).toBe(200)
    expect(res.body.events).toEqual([{ topics: ['0xdead'] }])
  })

  it('treats Etherscan "No records found" as empty success', async () => {
    process.env.ETHERSCAN_API_KEY = 'test-key'
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: '0', message: 'No records found', result: [] }), {
        status: 200,
      }),
    )

    const res = await request(app).get(`/events?address=${WHITELISTED}`)

    expect(res.status).toBe(200)
    expect(res.body.events).toEqual([])
  })

  it('returns 502 with NO upstream detail leak on Etherscan error', async () => {
    process.env.ETHERSCAN_API_KEY = 'test-key'
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: '0',
          message: 'NOTOK: rate limit hit, key=secret123',
          result: '',
        }),
        { status: 200 },
      ),
    )

    const res = await request(app).get(`/events?address=${WHITELISTED}`)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('etherscan error')
    expect(JSON.stringify(res.body)).not.toContain('secret123')
    expect(JSON.stringify(res.body)).not.toContain('rate limit')
  })

  it('returns 400 when topic0 is malformed', async () => {
    process.env.ETHERSCAN_API_KEY = 'test-key'

    const res = await request(app).get(`/events?address=${WHITELISTED}&topic0=0xshort`)

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
