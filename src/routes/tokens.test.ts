import request from 'supertest'
import { app } from '../app'
import { _resetProviderStateForTests } from '../lib/priceProviders'

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

  it('celo-mainnet: returns all 6 tokens with priceUsd from DIA', async () => {
    mockFetchByHost({
      'api.diadata.org': (url) => {
        const addr = url.pathname.split('/').pop()!.toLowerCase()
        const priceByAddr: Record<string, number> = {
          '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e': 0.9992,
          '0xceba9300f2b948710d2653dd7b07f33a8b32118c': 0.9998,
          '0x765de816845861e75a25fca122bb6898b8b1282a': 1.0001,
          '0x8a567e2ae79ca692bd748ab832081c45de4041ea': 0.000307,
          '0x68749665ff8d2d112fa859aa293f07a622782f38': 4357.21,
        }
        return jsonRes({ Symbol: 'MOCK', Price: priceByAddr[addr] ?? null })
      },
    })
    const res = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    expect(res.status).toBe(200)
    // The 6 wallet tokens must all be present as keys
    const keys = Object.keys(res.body)
    expect(keys).toHaveLength(6)
    expect(keys).toEqual(
      expect.arrayContaining([
        'celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
        'celo-mainnet:0xceba9300f2b948710d2653dd7b07f33a8b32118c',
        'celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a',
        'celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea',
        'celo-mainnet:0xc825b96be7e15e1c313ff3ceafda4432a17b6a1a',
        'celo-mainnet:0xa2036f0538221a77a3937f1379699f44945018d0',
      ]),
    )
    // Wallet uses priceUsd as string
    const usdt = res.body['celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e']
    expect(usdt.priceUsd).toBe('0.9992')
    expect(usdt.priceFetchedAt).toBeGreaterThan(0)
    // USAT hardcoded 1.0 since DIA has no entry
    const usat = res.body['celo-mainnet:0xa2036f0538221a77a3937f1379699f44945018d0']
    expect(usat.priceUsd).toBe('1')
  })

  it('preserves symbol quirks the wallet already handles (USD₮ unicode)', async () => {
    mockFetchByHost({
      'api.diadata.org': () => jsonRes({ Symbol: 'MOCK', Price: 1.0 }),
    })
    const res = await request(app).get('/api/tokens/info?networkIds=celo-mainnet')
    const usdt = res.body['celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e']
    expect(usdt.symbol).toBe('USD₮')
    const copm = res.body['celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea']
    expect(copm.symbol).toBe('cCOP')
    const usdm = res.body['celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a']
    expect(usdm.symbol).toBe('cUSD')
  })

  it('degraded scenario: DIA down + CoinGecko rate-limited -> hardcoded 1.0 fires for USD-pegged', async () => {
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
    // COPm / XAUt have NO hardcoded and stay without priceUsd
    const copm = res.body['celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea']
    expect(copm.priceUsd).toBeUndefined()
    const xaut = res.body['celo-mainnet:0xc825b96be7e15e1c313ff3ceafda4432a17b6a1a']
    expect(xaut.priceUsd).toBeUndefined()
  })
})
