import request from 'supertest'
import { app } from '../app'

const mockRedisGet = jest.fn()
const mockRedisSet = jest.fn()
const mockRedisClient = { get: mockRedisGet, set: mockRedisSet }
let useRedis = false

jest.mock('../lib/redis', () => ({
  getRedis: () => (useRedis ? mockRedisClient : null),
}))

const mockGetUniswapV4Quote: jest.Mock = jest.fn()
const mockIsUsdtCopmPair: jest.Mock = jest.fn()
jest.mock('../lib/uniswapV4', () => {
  const actual = jest.requireActual('../lib/uniswapV4')
  return {
    ...actual,
    getUniswapV4Quote: (
      direction: 'USDT_TO_COPM' | 'COPM_TO_USDT',
      exactAmount: bigint,
    ) => mockGetUniswapV4Quote(direction, exactAmount),
    isUsdtCopmPair: (sell: string, buy: string) =>
      mockIsUsdtCopmPair(sell, buy),
  }
})

const mockGetPermit2AllowanceInfo: jest.Mock = jest.fn()
const mockIsEip7702Delegated: jest.Mock = jest.fn()
const mockGetErc20Allowance: jest.Mock = jest.fn()
jest.mock('../lib/uniswapV4Executor', () => {
  const actual = jest.requireActual('../lib/uniswapV4Executor')
  return {
    ...actual,
    getPermit2AllowanceInfo: (
      user: `0x${string}`,
      token: `0x${string}`,
      spender?: `0x${string}`,
    ) => mockGetPermit2AllowanceInfo(user, token, spender),
    isEip7702Delegated: (user: `0x${string}`) => mockIsEip7702Delegated(user),
    getErc20Allowance: (
      token: `0x${string}`,
      owner: `0x${string}`,
      spender: `0x${string}`,
    ) => mockGetErc20Allowance(token, owner, spender),
  }
})

// Synthetic test address. Avoid wallet-shaped prefixes that might collide with
// a real maintainer key.
const USER = '0x3333333333333333333333333333333333333333'
const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const USDM = '0x765de816845861e75a25fca122bb6898b8b1282a'
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

  it('rejects unknown query param without echoing param name', async () => {
    const res = await request(app).get('/api/swap/quote?' + paramsTo() + '&evil=1')
    expect(res.status).toBe(400)
    // Canonical message; the param name 'evil' MUST NOT be reflected.
    expect(res.body.error).toBe('unknown param')
    expect(res.body.error).not.toMatch(/evil/)
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
      details: {
        swapProvider: 'squid',
        worstCaseSellAmount: '1000000',
      },
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

  it('Squid path guaranteedPrice: cross-decimal USDT (6-dec) -> USDm (18-dec) stays human-readable (regression for wallet approve() sizing bug)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          route: {
            estimate: {
              fromAmount: '1000000',
              toAmount: '994454241988839083',
              toAmountMin: '989481970778894887',
              exchangeRate: '0.994454241988839083',
              aggregatePriceImpact: '0.0',
              estimatedRouteDuration: 30,
              feeCosts: [],
              gasCosts: [{ amount: '0', limit: '200000' }],
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
      ),
    )
    const res = await request(app).get(
      '/api/swap/quote?' + paramsTo({ sellToken: USDT, buyToken: USDM, sellAmount: '1000000' }),
    )
    expect(res.status).toBe(200)
    const price = Number(res.body.unvalidatedSwapTransaction.price)
    const guaranteedPrice = Number(res.body.unvalidatedSwapTransaction.guaranteedPrice)
    expect(price).toBeGreaterThan(0.9)
    expect(price).toBeLessThan(1.1)
    expect(guaranteedPrice).toBeGreaterThan(0.9)
    expect(guaranteedPrice).toBeLessThan(1.1)
    expect(guaranteedPrice).toBeLessThanOrEqual(price)
    expect(guaranteedPrice).toBeGreaterThan(price * 0.99)
  })

  it('Squid path guaranteedPrice: cross-decimal USDm (18-dec) -> USDT (6-dec) stays human-readable', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          route: {
            estimate: {
              fromAmount: '1000000000000000000',
              toAmount: '994500',
              toAmountMin: '989527',
              exchangeRate: '0.9945',
              aggregatePriceImpact: '0.0',
              estimatedRouteDuration: 30,
              feeCosts: [],
              gasCosts: [{ amount: '0', limit: '200000' }],
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
      ),
    )
    const res = await request(app).get(
      '/api/swap/quote?' + paramsTo({
        sellToken: USDM,
        buyToken: USDT,
        sellAmount: '1000000000000000000',
      }),
    )
    expect(res.status).toBe(200)
    const price = Number(res.body.unvalidatedSwapTransaction.price)
    const guaranteedPrice = Number(res.body.unvalidatedSwapTransaction.guaranteedPrice)
    expect(price).toBeGreaterThan(0.9)
    expect(price).toBeLessThan(1.1)
    expect(guaranteedPrice).toBeGreaterThan(0.9)
    expect(guaranteedPrice).toBeLessThan(1.1)
    expect(guaranteedPrice).toBeLessThanOrEqual(price)
  })

  it('Squid path guaranteedPrice: same-decimal USDC->USDT stays correct (regression guard on the fix)', async () => {
    fetchSpy.mockResolvedValueOnce(squidResponse())
    const res = await request(app).get('/api/swap/quote?' + paramsTo())
    expect(res.status).toBe(200)
    expect(res.body.unvalidatedSwapTransaction.price).toBe('0.998')
    const gp = Number(res.body.unvalidatedSwapTransaction.guaranteedPrice)
    expect(gp).toBeGreaterThan(0.99)
    expect(gp).toBeLessThan(0.998)
    expect(gp).toBeCloseTo(0.993, 3)
  })

  it('Squid path: details.worstCaseSellAmount equals fromAmount (dedicated approve-size field)', async () => {
    // Wallet team feedback (2026-08-21): the existing `guaranteedPrice`
    // wire field cannot be used to derive `amountToApprove` on cross-
    // decimal pairs without per-token decimals lookup wallet-side. The
    // backend now emits `details.worstCaseSellAmount` = fromAmount so
    // the wallet's useSwapQuote.ts approve path can consume a single
    // pre-computed wei-SELL value regardless of pair decimals.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          route: {
            estimate: {
              fromAmount: '1000000',
              toAmount: '994454241988839083',
              toAmountMin: '989481970778894887',
              exchangeRate: '0.994454241988839083',
              aggregatePriceImpact: '0.0',
              feeCosts: [],
              gasCosts: [{ amount: '0', limit: '200000' }],
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
      ),
    )
    const res = await request(app).get(
      '/api/swap/quote?' + paramsTo({ sellToken: USDT, buyToken: USDM, sellAmount: '1000000' }),
    )
    expect(res.status).toBe(200)
    expect(res.body.details.swapProvider).toBe('squid')
    expect(res.body.details.worstCaseSellAmount).toBe('1000000')
    // Wallet-side integration: approve amount is now a direct BigInt of
    // this field. No math against guaranteedPrice, no per-token decimals.
    expect(BigInt(res.body.details.worstCaseSellAmount)).toBe(1000000n)
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

  describe('integrator fees (ENABLE_SQUID_INTEGRATOR_FEES flag)', () => {
    const FEE_ADDRESS = '0x17CD032F61998cD0E8e9AF87c8390b98496b9354'
    const FEE_PERCENTAGE = '0.5'

    beforeEach(() => {
      delete process.env.ENABLE_SQUID_INTEGRATOR_FEES
      delete process.env.SQUID_INTEGRATOR_FEE_ADDRESS
      delete process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE
    })

    it('flag OFF (default): request body has no collectFees, response has no appFeePercentageIncludedInPrice', async () => {
      // Baseline: identical to the pre-feature behaviour. This is THE test
      // that guards live users during a merge with the flag off.
      fetchSpy.mockResolvedValueOnce(squidResponse())

      const res = await request(app).get('/api/swap/quote?' + paramsTo())

      expect(res.status).toBe(200)
      expect(res.body.unvalidatedSwapTransaction).not.toHaveProperty(
        'appFeePercentageIncludedInPrice',
      )
      const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)
      expect(body).not.toHaveProperty('collectFees')
    })

    it('flag ON with env set: request body includes collectFees, response includes appFeePercentageIncludedInPrice', async () => {
      process.env.ENABLE_SQUID_INTEGRATOR_FEES = 'true'
      process.env.SQUID_INTEGRATOR_FEE_ADDRESS = FEE_ADDRESS
      process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE = FEE_PERCENTAGE
      fetchSpy.mockResolvedValueOnce(
        squidResponse({ appFeePercentageIncludedInPrice: '0.5' }),
      )

      const res = await request(app).get('/api/swap/quote?' + paramsTo())

      expect(res.status).toBe(200)
      expect(res.body.unvalidatedSwapTransaction.appFeePercentageIncludedInPrice).toBe(
        '0.5',
      )
      const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)
      expect(body.collectFees).toEqual({
        integratorAddress: FEE_ADDRESS,
        feeType: 'percentage',
        feeValue: 0.5,
      })
    })

    it('flag ON but Squid did NOT echo appFeePercentageIncludedInPrice: falls back to requested percentage', async () => {
      // Squid may omit the echo field for routes that could not honor the
      // integrator fee (e.g. an intermediate hop that does not support it).
      // We still surface the REQUESTED percentage so the wallet renders a
      // fee line matching what the user will actually be charged on the
      // hops that do apply it.
      process.env.ENABLE_SQUID_INTEGRATOR_FEES = 'true'
      process.env.SQUID_INTEGRATOR_FEE_ADDRESS = FEE_ADDRESS
      process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE = FEE_PERCENTAGE
      fetchSpy.mockResolvedValueOnce(squidResponse()) // no echo

      const res = await request(app).get('/api/swap/quote?' + paramsTo())

      expect(res.status).toBe(200)
      expect(res.body.unvalidatedSwapTransaction.appFeePercentageIncludedInPrice).toBe(
        '0.5',
      )
    })

    it('flag ON: cache key differs vs flag OFF so a flip does not serve stale cross-state responses', async () => {
      useRedis = true

      // First hit: flag OFF, populates cache under the "_fees=0" bucket.
      mockRedisGet.mockResolvedValueOnce(null)
      fetchSpy.mockResolvedValueOnce(squidResponse())
      await request(app).get('/api/swap/quote?' + paramsTo())
      const keyOff = mockRedisSet.mock.calls[0]?.[0] as string

      // Second hit: flag ON. Cache lookup must use a DIFFERENT key so the
      // OFF-state cached value is not returned. Redis returns null for the
      // new key -> upstream is called again.
      process.env.ENABLE_SQUID_INTEGRATOR_FEES = 'true'
      process.env.SQUID_INTEGRATOR_FEE_ADDRESS = FEE_ADDRESS
      process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE = FEE_PERCENTAGE
      mockRedisGet.mockResolvedValueOnce(null)
      fetchSpy.mockResolvedValueOnce(
        squidResponse({ appFeePercentageIncludedInPrice: '0.5' }),
      )
      await request(app).get('/api/swap/quote?' + paramsTo())
      const keyOn = mockRedisSet.mock.calls[1]?.[0] as string

      expect(keyOff).not.toBe(keyOn)
      // Both hits went to upstream (no cross-state cache hit).
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
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

  describe('Uniswap V4 shadow log (SWAP_FALLBACK_UNISWAP_V4_ENABLED)', () => {
    // The USDT<->COPm pair triggers the shadow. Params helper for that pair.
    const COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'
    function usdtCopmParams(overrides: Record<string, string> = {}): string {
      return paramsTo({
        buyToken: COPM,
        sellToken: USDT,
        sellAmount: '2000000',
        ...overrides,
      })
    }

    // Stubs at module top-level via jest.mock. Reset + configure per test.
    beforeEach(() => {
      mockGetUniswapV4Quote.mockReset()
      mockIsUsdtCopmPair.mockReset()
      // Default: real detector recognizes USDT<->COPm; tests can override.
      mockIsUsdtCopmPair.mockImplementation((sell: string, buy: string) => {
        const s = sell.toLowerCase()
        const b = buy.toLowerCase()
        if (s === USDT && b === COPM) return 'USDT_TO_COPM'
        if (s === COPM && b === USDT) return 'COPM_TO_USDT'
        return null
      })
    })

    afterEach(() => {
      delete process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED
    })

    it('flag OFF: does NOT call Uniswap V4 Quoter, even for USDT<->COPm pair', async () => {
      // Baseline: no extra RPC roundtrip when the flag is off. Guards against
      // ambient shadow calls that would burn Alchemy CU/s budget for nothing.
      fetchSpy.mockResolvedValueOnce(squidResponse())
      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())
      expect(res.status).toBe(200)
      expect(mockGetUniswapV4Quote).not.toHaveBeenCalled()
    })

    it('flag ON + non-USDT<->COPm pair: does NOT call Uniswap V4 (detector says no)', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      fetchSpy.mockResolvedValueOnce(squidResponse())
      // paramsTo() defaults to USDC/USDT, not USDT/COPm.
      const res = await request(app).get('/api/swap/quote?' + paramsTo())
      expect(res.status).toBe(200)
      expect(mockGetUniswapV4Quote).not.toHaveBeenCalled()
    })

    it('flag ON + USDT->COPm + Squid OK + Uniswap OK: response unchanged (still Squid), shadow log emitted', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      mockGetUniswapV4Quote.mockResolvedValueOnce({
        amountOut: 6484000000000000000000n,
        gasEstimate: 36719n,
      })
      fetchSpy.mockResolvedValueOnce(squidResponse({ toAmount: '5000000000000000000000' }))

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(200)
      // Response is still Squid-shaped. No new fields, no source key.
      expect(res.body).toMatchObject({ details: { swapProvider: 'squid' } })
      expect(res.body).not.toHaveProperty('source')
      // Uniswap Quoter WAS called with the right direction + amount.
      expect(mockGetUniswapV4Quote).toHaveBeenCalledWith('USDT_TO_COPM', 2_000_000n)
    })

    it('flag ON + USDT->COPm + Squid 502 + Uniswap OK: still returns 502 (Fase 1 does not route), shadow log captures the gap', async () => {
      // This is exactly the weekend Mento scenario. Fase 1 records the
      // opportunity but does not yet act on it; Fase 2 will.
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      mockGetUniswapV4Quote.mockResolvedValueOnce({
        amountOut: 6484000000000000000000n,
        gasEstimate: 36719n,
      })
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }))

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(502)
      expect(res.body).toEqual({ error: 'squid upstream unavailable' })
      // Uniswap was still called + comparison log emitted.
      expect(mockGetUniswapV4Quote).toHaveBeenCalledTimes(1)
    })

    it('flag ON + Uniswap Quoter throws: does not break Squid path', async () => {
      // Uniswap-side failure must not leak into the user response. Squid
      // still serves; shadow log records the Uniswap error.
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      mockGetUniswapV4Quote.mockRejectedValueOnce(new Error('rpc timeout'))
      fetchSpy.mockResolvedValueOnce(squidResponse())

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ details: { swapProvider: 'squid' } })
    })

    it('flag ON + USDT->COPm + Squid 429: preserves 429 pass-through even with shadow active', async () => {
      // The 429 path is separate from the 502 path; wallet team said rate-limit
      // "probably NO gatilla Uniswap sino retry". Verify shadow doesn't change
      // the 429 semantics.
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      mockGetUniswapV4Quote.mockResolvedValueOnce(null) // no liquidity
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '3' } }),
      )

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(429)
      expect(res.headers['retry-after']).toBe('3')
    })
  })

  describe('Uniswap V4 executor (SWAP_FALLBACK_UNISWAP_V4_ACTIVE)', () => {
    const COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'
    function usdtCopmParams(overrides: Record<string, string> = {}): string {
      return paramsTo({
        buyToken: COPM,
        sellToken: USDT,
        sellAmount: '2000000',
        ...overrides,
      })
    }

    beforeEach(() => {
      mockGetUniswapV4Quote.mockReset()
      mockIsUsdtCopmPair.mockReset()
      mockGetPermit2AllowanceInfo.mockReset()
      mockIsEip7702Delegated.mockReset()
      mockIsUsdtCopmPair.mockImplementation((sell: string, buy: string) => {
        const s = sell.toLowerCase()
        const b = buy.toLowerCase()
        if (s === USDT && b === COPM) return 'USDT_TO_COPM'
        if (s === COPM && b === USDT) return 'COPM_TO_USDT'
        return null
      })
      mockGetPermit2AllowanceInfo.mockResolvedValue({
        amount: 0n,
        expiration: 0,
        nonce: 0,
      })
      // Default: user NOT delegated -> Permit2 signature path (existing
      // integration tests remain valid for this branch).
      mockIsEip7702Delegated.mockResolvedValue(false)
      // Default: no ERC20 allowance to Permit2 (fresh EOA scenario).
      // Delegated-branch tests override this per case.
      mockGetErc20Allowance.mockReset()
      mockGetErc20Allowance.mockResolvedValue(0n)
    })

    afterEach(() => {
      delete process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED
      delete process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE
    })

    it('active flag ON + Uniswap wins price: returns uniswap-v4 provider + permit2 payload', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      mockGetUniswapV4Quote.mockResolvedValueOnce({
        amountOut: 6484000000000000000000n, // more than Squid
        gasEstimate: 36719n,
      })
      fetchSpy.mockResolvedValueOnce(
        squidResponse({ toAmount: '5000000000000000000000' }),
      )

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(200)
      expect(res.body.details.swapProvider).toBe('uniswap-v4')
      expect(res.body.details.worstCaseSellAmount).toBe('2000000')
      expect(res.body.unvalidatedSwapTransaction.data).toBe('0x')
      expect(res.body.unvalidatedSwapTransaction.allowanceTarget).toBe(
        '0x000000000022d473030f116ddee9f6b43ac78ba3',
      )
      expect(res.body.unvalidatedSwapTransaction.to).toBe(
        '0x8b844f885672f333bc0042cb669255f93a4c1e6b',
      )
      expect(res.body.details.permit2.typedData.primaryType).toBe('PermitSingle')
      expect(res.body.details.permit2.buildTxUrl).toBe('/api/swap/build-tx')
      expect(res.body.details.permit2.buildTxRequest.direction).toBe(
        'USDT_TO_COPM',
      )
      // Regression guard: price + guaranteedPrice must be human-readable
      // (whole/whole ratio adjusted for token decimals), NOT wei/wei.
      // Wallet renderer bails on magnitudes that don't match sellToken
      // in whole units. Bug caught by wallet team 2026-08-10.
      // For 2 USDT (10^6 * 2) -> 6484 COPm (10^18 * 6484), price should be
      // ~3242 (COPm per USDT), NOT ~3.24e15 (wei per wei).
      const price = res.body.unvalidatedSwapTransaction.price
      expect(price).toMatch(/^\d+(\.\d+)?$/)
      const priceNum = Number(price)
      expect(priceNum).toBeGreaterThan(1000)
      expect(priceNum).toBeLessThan(10000)
      const guaranteedPrice =
        res.body.unvalidatedSwapTransaction.guaranteedPrice
      expect(Number(guaranteedPrice)).toBeGreaterThan(1000)
      expect(Number(guaranteedPrice)).toBeLessThan(10000)
    })

    it('COPm->USDT direction: price is human-readable (0.0003xx, NOT wei/wei)', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      mockGetUniswapV4Quote.mockResolvedValueOnce({
        amountOut: 1018330n, // ~1 USDT (6 decimals) out for 3242 COPm in
        gasEstimate: 36719n,
      })
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }))
      const res = await request(app)
        .get('/api/swap/quote?' + usdtCopmParams({
          sellToken: COPM,
          buyToken: USDT,
          sellAmount: '3242000000000000000000',
        }))
      expect(res.status).toBe(200)
      expect(res.body.details.swapProvider).toBe('uniswap-v4')
      const price = Number(res.body.unvalidatedSwapTransaction.price)
      // ~0.000314 USDT per 1 COPm. Sanity: between 1e-5 and 1e-2.
      expect(price).toBeGreaterThan(1e-5)
      expect(price).toBeLessThan(1e-2)
    })

    it('active flag ON + Uniswap loses price: returns Squid (unchanged wire)', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      mockGetUniswapV4Quote.mockResolvedValueOnce({
        amountOut: 1000000000000000000n, // way less than Squid
        gasEstimate: 36719n,
      })
      fetchSpy.mockResolvedValueOnce(
        squidResponse({ toAmount: '5000000000000000000000' }),
      )

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(200)
      expect(res.body.details.swapProvider).toBe('squid')
    })

    it('active flag ON + Squid 502 + Uniswap OK: returns Uniswap response instead of 502', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      mockGetUniswapV4Quote.mockResolvedValueOnce({
        amountOut: 6484000000000000000000n,
        gasEstimate: 36719n,
      })
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }))

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(200)
      expect(res.body.details.swapProvider).toBe('uniswap-v4')
    })

    it('active flag OFF (shadow ON): even if Uniswap wins, returns Squid', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
      delete process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE
      mockGetUniswapV4Quote.mockResolvedValueOnce({
        amountOut: 6484000000000000000000n,
        gasEstimate: 36719n,
      })
      fetchSpy.mockResolvedValueOnce(
        squidResponse({ toAmount: '5000000000000000000000' }),
      )

      const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())

      expect(res.status).toBe(200)
      expect(res.body.details.swapProvider).toBe('squid')
    })

    describe('EIP-7702 delegated user: batchCalls path (option B)', () => {
      beforeEach(() => {
        process.env.SWAP_FALLBACK_UNISWAP_V4_ENABLED = 'true'
        process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
        mockIsEip7702Delegated.mockResolvedValue(true)
      })

      it('user with sufficient ERC20 allowance: batchCalls = [Permit2.approve, UR.execute] (2 items)', async () => {
        mockGetErc20Allowance.mockResolvedValueOnce(
          10_000_000_000n, // 10k USDT, way more than needed
        )
        mockGetUniswapV4Quote.mockResolvedValueOnce({
          amountOut: 6484000000000000000000n,
          gasEstimate: 36719n,
        })
        fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }))
        const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())
        expect(res.status).toBe(200)
        expect(res.body.details.swapProvider).toBe('uniswap-v4')
        expect(res.body.details.permit2).toBeUndefined()
        expect(res.body.details.batchCalls).toHaveLength(2)
        expect(res.body.details.batchCalls[0].to).toBe(
          '0x000000000022d473030f116ddee9f6b43ac78ba3',
        )
        expect(res.body.details.batchCalls[0].data.startsWith('0x87517c45')).toBe(true)
        expect(res.body.details.batchCalls[1].to).toBe(
          '0x8b844f885672f333bc0042cb669255f93a4c1e6b',
        )
      })

      it('fresh user (zero ERC20 allowance): batchCalls = [USDT.approve, Permit2.approve, UR.execute] (3 items)', async () => {
        mockGetErc20Allowance.mockResolvedValueOnce(0n)
        mockGetUniswapV4Quote.mockResolvedValueOnce({
          amountOut: 6484000000000000000000n,
          gasEstimate: 36719n,
        })
        fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }))
        const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())
        expect(res.status).toBe(200)
        expect(res.body.details.batchCalls).toHaveLength(3)
        // [0] = USDT.approve(Permit2, sellAmount)
        expect(res.body.details.batchCalls[0].to).toBe(USDT)
        expect(res.body.details.batchCalls[0].data.startsWith('0x095ea7b3')).toBe(true) // ERC20 approve selector
        // [1] = Permit2.approve
        expect(res.body.details.batchCalls[1].to).toBe(
          '0x000000000022d473030f116ddee9f6b43ac78ba3',
        )
        expect(res.body.details.batchCalls[1].data.startsWith('0x87517c45')).toBe(true)
        // [2] = UR.execute
        expect(res.body.details.batchCalls[2].to).toBe(
          '0x8b844f885672f333bc0042cb669255f93a4c1e6b',
        )
      })

      it('user with non-zero-but-insufficient ERC20 allowance: batchCalls = [approve 0, approve target, Permit2.approve, UR.execute] (4 items, Tether edge)', async () => {
        mockGetErc20Allowance.mockResolvedValueOnce(1_000n) // < 2 USDT (sellAmount)
        mockGetUniswapV4Quote.mockResolvedValueOnce({
          amountOut: 6484000000000000000000n,
          gasEstimate: 36719n,
        })
        fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }))
        const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())
        expect(res.status).toBe(200)
        expect(res.body.details.batchCalls).toHaveLength(4)
        // [0] = USDT.approve(Permit2, 0) - Tether reset
        expect(res.body.details.batchCalls[0].to).toBe(USDT)
        expect(res.body.details.batchCalls[0].data.startsWith('0x095ea7b3')).toBe(true)
        // [1] = USDT.approve(Permit2, sellAmount)
        expect(res.body.details.batchCalls[1].to).toBe(USDT)
        expect(res.body.details.batchCalls[1].data.startsWith('0x095ea7b3')).toBe(true)
        // [2] = Permit2.approve
        expect(res.body.details.batchCalls[2].to).toBe(
          '0x000000000022d473030f116ddee9f6b43ac78ba3',
        )
        // [3] = UR.execute
        expect(res.body.details.batchCalls[3].to).toBe(
          '0x8b844f885672f333bc0042cb669255f93a4c1e6b',
        )
      })

      it('non-delegated user gets permit2 path (existing behavior)', async () => {
        mockIsEip7702Delegated.mockResolvedValueOnce(false)
        mockGetUniswapV4Quote.mockResolvedValueOnce({
          amountOut: 6484000000000000000000n,
          gasEstimate: 36719n,
        })
        fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }))
        const res = await request(app).get('/api/swap/quote?' + usdtCopmParams())
        expect(res.status).toBe(200)
        expect(res.body.details.swapProvider).toBe('uniswap-v4')
        expect(res.body.details.batchCalls).toBeUndefined()
        expect(res.body.details.permit2).toBeDefined()
      })
    })
  })

  describe('POST /api/swap/build-tx', () => {
    beforeEach(() => {
      delete process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE
    })

    const validBody = () => ({
      direction: 'USDT_TO_COPM' as const,
      userAddress: '0x1111111111111111111111111111111111111111',
      sellAmount: '1000000',
      minBuyAmount: '3000000000000000000000',
      deadline: '9999999999',
      permit2Signature: '0x' + '11'.repeat(64) + '1b',
      permitToken: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', // USDT
      permitAmount: '1000000',
      permitExpiration: 1800000000,
      permitNonce: 0,
      permitSigDeadline: '9999999999',
    })

    it('flag OFF: returns 503', async () => {
      const res = await request(app).post('/api/swap/build-tx').send(validBody())
      expect(res.status).toBe(503)
    })

    it('flag ON + valid body: returns {to, data, value}', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      const res = await request(app).post('/api/swap/build-tx').send(validBody())
      expect(res.status).toBe(200)
      expect(res.body.to).toBe('0x8b844f885672f333bc0042cb669255f93a4c1e6b')
      expect(res.body.value).toBe('0')
      expect(res.body.data.startsWith('0x')).toBe(true)
      expect(res.body.data.length).toBeGreaterThan(200)
    })

    it('flag ON + wrong permitToken for direction: 400', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      const body = validBody()
      body.permitToken = '0x8a567e2ae79ca692bd748ab832081c45de4041ea' // COPm, not USDT
      const res = await request(app).post('/api/swap/build-tx').send(body)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/direction sell token/i)
    })

    it('flag ON + permitAmount < sellAmount: 400', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      const body = validBody()
      body.permitAmount = '500'
      const res = await request(app).post('/api/swap/build-tx').send(body)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/less than sellAmount/i)
    })

    it('flag ON + malformed signature: 400', async () => {
      process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE = 'true'
      const body = validBody()
      body.permit2Signature = '0x1234'
      const res = await request(app).post('/api/swap/build-tx').send(body)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/permit2Signature/i)
    })
  })
})
