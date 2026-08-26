import request from 'supertest'
import { app } from '../app'
import { _resetProviderStateForTests } from '../lib/priceProviders'
import { _resetTokensLastKnownPriceCacheForTests } from './tokens'

const REAL_FETCH = global.fetch

function mockFetchByHost(
  handlers: Partial<Record<string, (url: URL) => Response | Promise<Response>>>,
): void {
  global.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const h = handlers[url.hostname]
    if (!h) throw new Error(`unexpected fetch host in test: ${url.hostname}`)
    return h(url)
  }) as typeof global.fetch
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  _resetProviderStateForTests()
  _resetTokensLastKnownPriceCacheForTests()
})

afterEach(() => {
  global.fetch = REAL_FETCH
})

describe('GET /api/tokens/info', () => {
  it('400 when networkIds param is missing', async () => {
    const res = await request(app).get('/api/tokens/info')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('missing networkIds')
  })

  it('400 when networkIds contains an unsupported id', async () => {
    const res = await request(app).get('/api/tokens/info?networkIds=celo-mainnet,foo')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unsupported networkId')
  })

  it('celo-mainnet: returns all 7 tokens with priceUsd from DIA', async () => {
    mockFetchByHost({
      'api.diadata.org': (url) => {
        const addr = url.pathname.split('/').pop()!.toLowerCase()
        const priceByAddr: Record<string, number> = {
          '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e': 0.9992,
          '0xceba9300f2b948710d2653dd7b07f33a8b32118c': 0.9998,
          '0x765de816845861e75a25fca122bb6898b8b1282a': 1.0001,
          '0x8a567e2ae79ca692bd748ab832081c45de4041ea': 0.000307,
          '0x68749665ff8d2d112fa859aa293f07a622782f38': 4357.21,
          '0x471ece3750da237f93b8e339c536989b8978a438': 0.0642,
        }
        return jsonRes({ Symbol: 'MOCK', Price: priceByAddr[addr] ?? null })
      },
    })
    const res = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    expect(res.status).toBe(200)
    // The 7 wallet tokens must all be present as keys
    const keys = Object.keys(res.body)
    expect(keys).toHaveLength(7)
    expect(keys).toEqual(
      expect.arrayContaining([
        'celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
        'celo-mainnet:0xceba9300f2b948710d2653dd7b07f33a8b32118c',
        'celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a',
        'celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea',
        'celo-mainnet:0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff',
        'celo-mainnet:0xa2036f0538221a77a3937f1379699f44945018d0',
        'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438',
      ]),
    )
    // Wallet uses priceUsd as string
    const usdt = res.body['celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e']
    expect(usdt.priceUsd).toBe('0.9992')
    expect(usdt.priceFetchedAt).toBeGreaterThan(0)
    // USAT hardcoded 1.0 since DIA has no entry
    const usat = res.body['celo-mainnet:0xa2036f0538221a77a3937f1379699f44945018d0']
    expect(usat.priceUsd).toBe('1')
    // CELO priced from DIA, flagged isNative for the wallet
    const celo = res.body['celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438']
    expect(celo.symbol).toBe('CELO')
    expect(celo.isNative).toBe(true)
    expect(celo.priceUsd).toBe('0.0642')
    // imageUrl composed from PUBLIC_BASE_URL + /tokens/<file>
    expect(celo.imageUrl).toBe('https://backend.test/tokens/CELO.png')
    expect(usdt.imageUrl).toBe('https://backend.test/tokens/USDT.png')
  })

  it('symbols mirror on-chain: USD₮ unicode, USDm/COPm Mento rebrand', async () => {
    mockFetchByHost({
      'api.diadata.org': () => jsonRes({ Symbol: 'MOCK', Price: 1.0 }),
    })
    const res = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    const usdt = res.body['celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e']
    expect(usdt.symbol).toBe('USD₮')
    const copm = res.body['celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea']
    expect(copm.symbol).toBe('COPm')
    expect(copm.name).toBe('Mento Colombian Peso')
    const usdm = res.body['celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a']
    expect(usdm.symbol).toBe('USDm')
    expect(usdm.name).toBe('Mento Dollar')
  })

  it('Mento-native tokens carry isFeeCurrency:true (USDm + COPm parity)', async () => {
    // COPm is registered as a direct fee currency in the Celo
    // FeeCurrencyDirectory (0x15F344B9E6c3Cb6F0376A36A64928b13F62C6276)
    // alongside USDm; both use direct token address, no adapter. Wallet
    // filters fee currencies via `isNative || isFeeCurrency ||
    // feeCurrencyAdapterAddress`, so a missing flag on COPm blocks users
    // that only hold COPm from paying gas in COPm via CIP-64. Regression
    // guard for the 2026-08-26 wallet-team parity ask.
    mockFetchByHost({
      'api.diadata.org': () => jsonRes({ Symbol: 'MOCK', Price: 1.0 }),
    })
    const res = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    const usdm = res.body['celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a']
    const copm = res.body['celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea']
    expect(usdm.isFeeCurrency).toBe(true)
    expect(copm.isFeeCurrency).toBe(true)
    // Direct fee currencies (no adapter) — contrast with USDT/USDC.
    expect(usdm.feeCurrencyAdapterAddress).toBeUndefined()
    expect(copm.feeCurrencyAdapterAddress).toBeUndefined()
  })

  it('static route /tokens/<file>.png serves the self-hosted PNG', async () => {
    const res = await request(app).get('/tokens/CELO.png')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^image\/png/)
    // PNG magic bytes: 89 50 4E 47
    expect(res.body.slice(0, 4).toString('hex')).toBe('89504e47')
  })

  it('degraded scenario: DIA down + CoinGecko rate-limited -> hardcoded 1.0 fires for USD-pegged', async () => {
    // Cache is reset in beforeEach so this test starts with no last-known-good
    // entries, mirroring the cold-start pathological case.
    mockFetchByHost({
      'api.diadata.org': () => {
        throw new Error('dia down')
      },
      'api.coingecko.com': () => new Response('rate limited', { status: 429 }),
    })
    const res = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    expect(res.status).toBe(200)
    // USD-pegged fall through to hardcoded 1.0
    const usdt = res.body['celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e']
    expect(usdt.priceUsd).toBe('1')
    const usat = res.body['celo-mainnet:0xa2036f0538221a77a3937f1379699f44945018d0']
    expect(usat.priceUsd).toBe('1')
    // COPm / XAUt have NO hardcoded and stay without priceUsd (empty fallback cache)
    const copm = res.body['celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea']
    expect(copm.priceUsd).toBeUndefined()
    const xaut = res.body['celo-mainnet:0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff']
    expect(xaut.priceUsd).toBeUndefined()
  })

  it('last-known-price fallback: second request keeps priceUsd for COPm even when waterfall degrades to nothing', async () => {
    // Wallet team ask (2026-08-26): make cold-response waterfall miss serve
    // the last-known-good price instead of an omitted field, so fresh
    // installs that hit a transient degradation window still see a numeric
    // priceUsd. Fallback cap is 24h; anything older is dropped.
    const priceByAddr: Record<string, number> = {
      '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e': 0.9992,
      '0xceba9300f2b948710d2653dd7b07f33a8b32118c': 0.9998,
      '0x765de816845861e75a25fca122bb6898b8b1282a': 1.0001,
      '0x8a567e2ae79ca692bd748ab832081c45de4041ea': 0.000307,
      '0x68749665ff8d2d112fa859aa293f07a622782f38': 4357.21,
      '0x471ece3750da237f93b8e339c536989b8978a438': 0.0642,
    }
    // First request: DIA healthy, caches the last-known-good for every symbol.
    mockFetchByHost({
      'api.diadata.org': (url) => {
        const addr = url.pathname.split('/').pop()!.toLowerCase()
        return jsonRes({ Symbol: 'MOCK', Price: priceByAddr[addr] ?? null })
      },
    })
    const first = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    expect(first.status).toBe(200)
    const copmFirst = first.body['celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea']
    expect(copmFirst.priceUsd).toBe('0.000307')

    // Second request: DIA down + CoinGecko rate-limited. Without the
    // fallback, COPm / XAUt would come back with `priceUsd: undefined` (see
    // the prior test). With the fallback, we get the same string COPm
    // returned in the first request, plus the ORIGINAL priceFetchedAt.
    _resetProviderStateForTests() // circuit-breaker reset so waterfall attempts run again
    mockFetchByHost({
      'api.diadata.org': () => {
        throw new Error('dia down')
      },
      'api.coingecko.com': () => new Response('rate limited', { status: 429 }),
    })
    const second = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    expect(second.status).toBe(200)
    const copmSecond = second.body['celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea']
    expect(copmSecond.priceUsd).toBe('0.000307')
    // priceFetchedAt is the ORIGINAL fetch timestamp, so the wallet can
    // decide whether the price is stale enough to warn the user.
    expect(copmSecond.priceFetchedAt).toBe(copmFirst.priceFetchedAt)
    const xautSecond = second.body['celo-mainnet:0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff']
    expect(xautSecond.priceUsd).toBe('4357.21')
    // USD-pegged tokens keep the hardcoded 1.0 path; the fallback is
    // shadowed by the fresh hardcoded fetch.
    const usdtSecond = second.body['celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e']
    expect(usdtSecond.priceUsd).toBe('1')
  })
})
