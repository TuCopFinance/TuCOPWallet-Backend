import request from 'supertest'
import { app } from '../app'

const mockRedisGet = jest.fn()
const mockRedisSet = jest.fn()
const mockRedisClient = { get: mockRedisGet, set: mockRedisSet }
let useRedis = false

jest.mock('../lib/redis', () => ({
  getRedis: () => (useRedis ? mockRedisClient : null),
}))

const USER = '0xa203bb4b3eba27ad3a5e3da6b8d6b8d6b8d6b8d6'
const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const SWAP_TARGET = '0x1111111111111111111111111111111111111111'

function paramsTo(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    buyToken: USDT,
    buyIsNative: 'false',
    buyNetworkId: 'celo-mainnet',
    sellToken: USDC,
    sellIsNative: 'false',
    sellNetworkId: 'celo-mainnet',
    sellAmount: '1000000',
    userAddress: USER,
  }
  return new URLSearchParams({ ...base, ...overrides }).toString()
}

function squidResponse(extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      route: {
        estimate: {
          fromAmount: '1000000',
          toAmount: '998000',
          toAmountMin: '993000',
          exchangeRate: '0.998',
          aggregatePriceImpact: '0.2',
          estimatedRouteDuration: 30,
          feeCosts: [],
          gasCosts: [{ amount: '0', limit: '200000' }],
          ...extra,
        },
        transactionRequest: {
          target: SWAP_TARGET,
          data: '0xabcdef',
          value: '0',
          gasLimit: '300000',
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('GET /api/swap/quote', () => {
  const ORIGINAL_ENV = { ...process.env }
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    process.env.SQUID_INTEGRATOR_ID = 'tucop-test-integrator-id'
    fetchSpy = jest.spyOn(global, 'fetch')
    useRedis = false
    mockRedisGet.mockReset()
    mockRedisSet.mockReset()
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('rejects invalid sellToken', async () => {
    const res = await request(app).get('/api/swap/quote?' + paramsTo({ sellToken: '0xnothex' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sellToken/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects unknown query param', async () => {
    const res = await request(app).get('/api/swap/quote?' + paramsTo() + '&evil=1')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unknown param: evil/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 503 when SQUID_INTEGRATOR_ID is missing', async () => {
    delete process.env.SQUID_INTEGRATOR_ID
    const res = await request(app).get('/api/swap/quote?' + paramsTo())
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/integrator/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('proxies a same-chain quote and shapes the response', async () => {
    fetchSpy.mockResolvedValueOnce(squidResponse())

    const res = await request(app).get('/api/swap/quote?' + paramsTo())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      details: { swapProvider: 'squid' },
      unvalidatedSwapTransaction: {
        swapType: 'same-chain',
        chainId: 42220,
        buyAmount: '998000',
        sellAmount: '1000000',
        buyTokenAddress: USDT,
        sellTokenAddress: USDC,
        price: '0.998',
        estimatedPriceImpact: '0.2',
        gas: '300000',
        to: SWAP_TARGET,
        data: '0xabcdef',
        value: '0',
        from: USER,
        allowanceTarget: SWAP_TARGET,
      },
    })
    expect(res.body.unvalidatedSwapTransaction).not.toHaveProperty('estimatedDuration')
    expect(res.body.unvalidatedSwapTransaction).not.toHaveProperty('maxCrossChainFee')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://apiplus.squidrouter.com/v2/route')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'x-integrator-id': 'tucop-test-integrator-id' })
    const body = JSON.parse(init?.body as string)
    expect(body).toMatchObject({
      fromAddress: USER,
      fromChain: '42220',
      fromToken: USDC,
      fromAmount: '1000000',
      toChain: '42220',
      toToken: USDT,
      slippage: 0.5,
      quoteOnly: false,
    })
  })

  it('forwards quoteOnly=true to upstream (planning phase, no per-wallet bucket charge)', async () => {
    fetchSpy.mockResolvedValueOnce(squidResponse())

    await request(app).get('/api/swap/quote?' + paramsTo({ quoteOnly: 'true' }))

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)
    expect(body.quoteOnly).toBe(true)
  })

  it('defaults quoteOnly to false when omitted (commit phase)', async () => {
    fetchSpy.mockResolvedValueOnce(squidResponse())

    await request(app).get('/api/swap/quote?' + paramsTo())

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)
    expect(body.quoteOnly).toBe(false)
  })

  it('rejects invalid quoteOnly', async () => {
    const res = await request(app).get('/api/swap/quote?' + paramsTo({ quoteOnly: 'maybe' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/quoteOnly/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('substitutes the native-token sentinel when sellIsNative or buyIsNative is true', async () => {
    fetchSpy.mockResolvedValueOnce(squidResponse())

    await request(app).get('/api/swap/quote?' + paramsTo({ sellIsNative: 'true' }))

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)
    expect(body.fromToken).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
    expect(body.toToken).toBe(USDT)
  })

  it('proxies a cross-chain quote and includes the extra fields', async () => {
    fetchSpy.mockResolvedValueOnce(
      squidResponse({
        estimatedRouteDuration: 1800,
        feeCosts: [
          { amount: '100', name: 'Axelar Gas' },
          { amount: '50', name: 'Bridge Fee' },
        ],
      }),
    )

    const res = await request(app).get(
      '/api/swap/quote?' + paramsTo({ buyNetworkId: 'ethereum-mainnet' }),
    )

    expect(res.status).toBe(200)
    expect(res.body.unvalidatedSwapTransaction).toMatchObject({
      swapType: 'cross-chain',
      estimatedDuration: 1800,
      estimatedCrossChainFee: '150',
      maxCrossChainFee: '150',
    })
  })

  it('returns 502 when upstream returns 5xx (not rate-limit)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }))

    const res = await request(app).get('/api/swap/quote?' + paramsTo())

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('squid upstream unavailable')
  })

  it('passes through 429 + Retry-After header when Squid rate-limits us', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    )

    const res = await request(app).get('/api/swap/quote?' + paramsTo())

    expect(res.status).toBe(429)
    expect(res.body.error).toMatch(/rate limited/i)
    expect(res.headers['retry-after']).toBe('7')
  })

  it('returns 429 without Retry-After when upstream did not send one', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 429 }))

    const res = await request(app).get('/api/swap/quote?' + paramsTo())

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('does not echo upstream error body to the client', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'leaky-detail-with-integrator-id-secret-xyz' }), {
        status: 502,
      }),
    )

    const res = await request(app).get('/api/swap/quote?' + paramsTo())

    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain('secret-xyz')
    expect(JSON.stringify(res.body)).not.toContain('leaky-detail')
  })

  it('caches responses for 30 seconds (cache hit skips upstream)', async () => {
    useRedis = true
    mockRedisGet.mockResolvedValueOnce(null)
    fetchSpy.mockResolvedValueOnce(squidResponse())

    await request(app).get('/api/swap/quote?' + paramsTo())

    expect(mockRedisSet).toHaveBeenCalledTimes(1)
    const [key, , mode, ttl] = mockRedisSet.mock.calls[0]
    expect(key).toContain('squid:')
    expect(mode).toBe('EX')
    expect(ttl).toBe(30)

    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        unvalidatedSwapTransaction: { from: USER, fromCache: true },
        details: { swapProvider: 'squid' },
      }),
    )
    fetchSpy.mockClear()

    const second = await request(app).get('/api/swap/quote?' + paramsTo())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(second.body.unvalidatedSwapTransaction).toMatchObject({ fromCache: true })
  })
})
