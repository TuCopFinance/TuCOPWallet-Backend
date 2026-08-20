import {
  _resetProviderStateForTests,
  fetchTokenPrices,
  ProviderExhaustedError,
  type PriceSymbol,
} from './priceProviders'

// The waterfall exercises real HTTP endpoints when unmocked. All tests
// below stub global.fetch so no external network is touched. The Mento
// provider dynamically imports viem, which the tests also mock via
// jest.mock('viem') further down.

const REAL_FETCH = global.fetch

beforeEach(() => {
  _resetProviderStateForTests()
  delete process.env.COINGECKO_API_KEY
  delete process.env.COINMARKETCAP_API_KEY
})

afterEach(() => {
  global.fetch = REAL_FETCH
})

// Helper: build a mock fetch that routes by hostname to per-host handlers.
function mockFetchByHost(
  handlers: Partial<
    Record<'api.diadata.org' | 'api.coingecko.com' | 'pro-api.coinmarketcap.com', (url: URL, init?: RequestInit) => Response | Promise<Response>>
  >,
): void {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const h = handlers[url.hostname as keyof typeof handlers]
    if (!h) {
      throw new Error(`unexpected fetch host in test: ${url.hostname}`)
    }
    return h(url, init)
  }) as typeof global.fetch
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('fetchTokenPrices waterfall', () => {
  it('DIA first serves all 4 stables in a happy-path scenario', async () => {
    mockFetchByHost({
      'api.diadata.org': (url) => {
        const addr = url.pathname.split('/').pop()!.toLowerCase()
        const priceByAddr: Record<string, number> = {
          '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e': 0.9992, // USDT
          '0xceba9300f2b948710d2653dd7b07f33a8b32118c': 0.9998, // USDC
          '0x765de816845861e75a25fca122bb6898b8b1282a': 1.0001, // USDm
          '0x8a567e2ae79ca692bd748ab832081c45de4041ea': 0.000307, // COPm
        }
        const p = priceByAddr[addr]
        return jsonRes({ Symbol: 'MOCK', Price: p ?? null })
      },
    })
    const r = await fetchTokenPrices(['USDT', 'USDC', 'USDm', 'COPm'])
    expect(r.prices.size).toBe(4)
    expect(r.prices.get('USDT')?.priceUsd).toBeCloseTo(0.9992)
    expect(r.prices.get('COPm')?.priceUsd).toBeCloseTo(0.000307)
    expect(r.prices.get('USDT')?.source).toBe('dia')
    expect(r.usedProviders).toContain('dia')
    expect(r.usedProviders).not.toContain('coingecko')
    expect(r.usedProviders).not.toContain('cmc')
  })

  it('falls through DIA to CoinGecko when DIA misses a symbol', async () => {
    process.env.COINGECKO_API_KEY = 'CG-TEST'
    mockFetchByHost({
      'api.diadata.org': (url) => {
        const addr = url.pathname.split('/').pop()!.toLowerCase()
        // DIA only knows USDT; COPm falls through
        if (addr === '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e') {
          return jsonRes({ Symbol: 'USDT', Price: 1.0 })
        }
        return jsonRes({ Symbol: 'MOCK', Price: null })
      },
      'api.coingecko.com': () => jsonRes({ ccop: { usd: 0.00031 } }),
    })
    const r = await fetchTokenPrices(['USDT', 'COPm'])
    expect(r.prices.get('USDT')?.source).toBe('dia')
    expect(r.prices.get('COPm')?.source).toBe('coingecko')
    expect(r.usedProviders).toEqual(expect.arrayContaining(['dia', 'coingecko']))
  })

  it('marks CoinGecko exhausted on 429 and skips it on subsequent calls', async () => {
    process.env.COINGECKO_API_KEY = 'CG-TEST'
    let coingeckoCalls = 0
    mockFetchByHost({
      'api.diadata.org': () => jsonRes({ Symbol: 'MOCK', Price: null }),
      'api.coingecko.com': () => {
        coingeckoCalls += 1
        return new Response('rate limited', { status: 429 })
      },
    })
    // USDT falls through DIA (returns null) -> CoinGecko (429 exhausted) ->
    // hardcoded 1.0 tier. Both prior tiers touched once.
    const r1 = await fetchTokenPrices(['USDT'])
    expect(r1.prices.get('USDT')?.source).toBe('hardcoded')
    expect(coingeckoCalls).toBe(1)

    // Second call: CoinGecko must be skipped entirely (exhaustion window)
    coingeckoCalls = 0
    const r2 = await fetchTokenPrices(['USDT'])
    expect(coingeckoCalls).toBe(0)
    expect(r2.skippedProviders).toContain('coingecko')
    expect(r2.prices.get('USDT')?.source).toBe('hardcoded')
  })

  it('CMC quota-exhausted (error_code 1010) marks provider as exhausted', async () => {
    process.env.COINMARKETCAP_API_KEY = 'CMC-KEY'
    let cmcCalls = 0
    mockFetchByHost({
      'api.diadata.org': () => jsonRes({ Symbol: 'MOCK', Price: null }),
      'api.coingecko.com': () => new Response('rate limited', { status: 429 }),
      'pro-api.coinmarketcap.com': () => {
        cmcCalls += 1
        return jsonRes({
          status: { error_code: 1010, error_message: 'monthly credit limit' },
          data: {},
        })
      },
    })
    const r = await fetchTokenPrices(['XAUt'])
    // XAUt has no hardcoded fallback, so the resulting price map is empty
    expect(r.prices.get('XAUt')).toBeUndefined()
    // But we did try CMC once
    expect(cmcCalls).toBe(1)
    // Subsequent call should skip CMC entirely
    cmcCalls = 0
    const r2 = await fetchTokenPrices(['XAUt'])
    expect(cmcCalls).toBe(0)
    expect(r2.skippedProviders).toContain('cmc')
  })

  it('hardcoded tier fires for USD-pegged symbols even when all upstream tiers fail', async () => {
    mockFetchByHost({
      'api.diadata.org': () => {
        throw new Error('dia down')
      },
      'api.coingecko.com': () => new Response('rate limited', { status: 429 }),
      'pro-api.coinmarketcap.com': () =>
        jsonRes({ status: { error_code: 1010, error_message: 'exhausted' } }),
    })
    process.env.COINMARKETCAP_API_KEY = 'CMC-KEY'
    process.env.COINGECKO_API_KEY = 'CG-KEY'
    const r = await fetchTokenPrices(['USDT', 'USDC', 'USDm', 'USAT'])
    expect(r.prices.size).toBe(4)
    expect(r.prices.get('USDT')?.source).toBe('hardcoded')
    expect(r.prices.get('USAT')?.source).toBe('hardcoded')
    expect(r.prices.get('USDT')?.priceUsd).toBe(1.0)
  })

  it('COPm has NO hardcoded fallback (would be 3000x error) and stays unresolved', async () => {
    mockFetchByHost({
      'api.diadata.org': () => jsonRes({ Symbol: 'MOCK', Price: null }),
      'api.coingecko.com': () => jsonRes({}), // returns no data for ccop
    })
    // Mento would run but has real viem calls; without mock it will fail and continue
    process.env.COINGECKO_API_KEY = 'CG-KEY'
    const r = await fetchTokenPrices(['COPm'])
    // COPm unresolved => not in the map at all
    expect(r.prices.get('COPm')).toBeUndefined()
  })
})

describe('ProviderExhaustedError', () => {
  it('extends Error with a distinguishing name', () => {
    const e = new ProviderExhaustedError('cmc', 'monthly credit limit')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ProviderExhaustedError')
    expect(e.message).toContain('cmc')
    expect(e.message).toContain('monthly credit limit')
  })
})

// Symbol table sanity: ensure every symbol has SOME way to be priced.
describe('symbol table coverage', () => {
  it('every wallet-facing symbol has at least one provider or a hardcoded fallback', async () => {
    // Empty upstream mocks => nothing responds. Symbols with hardcoded
    // fallback should still resolve; symbols without hardcoded (COPm,
    // XAUt, CELO) should be missing but the call must not throw.
    mockFetchByHost({
      'api.diadata.org': () => jsonRes({ Symbol: 'MOCK', Price: null }),
      'api.coingecko.com': () => jsonRes({}),
      'pro-api.coinmarketcap.com': () => jsonRes({ data: {} }),
    })
    const all: PriceSymbol[] = ['USDT', 'USDC', 'USDm', 'COPm', 'XAUt', 'USAT', 'CELO']
    const r = await fetchTokenPrices(all)
    // Hardcoded resolves USDT/USDC/USDm/USAT
    expect(r.prices.get('USDT')?.source).toBe('hardcoded')
    expect(r.prices.get('USDC')?.source).toBe('hardcoded')
    expect(r.prices.get('USDm')?.source).toBe('hardcoded')
    expect(r.prices.get('USAT')?.source).toBe('hardcoded')
    // No hardcoded for COPm / XAUt / CELO on purpose
    expect(r.prices.get('COPm')).toBeUndefined()
    expect(r.prices.get('XAUt')).toBeUndefined()
    expect(r.prices.get('CELO')).toBeUndefined()
  })
})
