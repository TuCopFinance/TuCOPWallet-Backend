import express from 'express'
import request from 'supertest'
import type { NeeruIndexerRpcClient } from '../neeru-indexer/rpc'
import { _resetHooksApiNeeruCacheForTests } from '../hooks-api/neeru/positions'

const ORIGINAL_ENV = { ...process.env }

function loadFreshRouter(overrides: Record<string, string | undefined>): {
  router: express.Router
  setRpc: (client: NeeruIndexerRpcClient | null) => void
} {
  jest.resetModules()
  process.env = { ...ORIGINAL_ENV }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./earn-neeru-catalogue')
  return {
    router: mod.default as express.Router,
    setRpc: mod._setEarnNeeruCatalogueRpcForTests as (
      client: NeeruIndexerRpcClient | null,
    ) => void,
  }
}

afterAll(() => {
  process.env = { ...ORIGINAL_ENV }
})

afterEach(() => {
  _resetHooksApiNeeruCacheForTests()
})

const CONTRACT = '0x988af5977201a0e988f2c75ea952532f6beb5082'
const DEPOSIT_TOKEN = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'
const TOKEN_DECIMALS = 18
const TOKEN_SYMBOL = 'COPm'

// Category rates chosen so monthly + annual come out to easy-to-read
// numbers: flexible ~= 0, others increasing.
const CAT_RATES: readonly bigint[] = [
  BigInt(Math.round(1e27 * 1.0000)),
  BigInt(Math.round(1e27 * 1.0001)),
  BigInt(Math.round(1e27 * 1.0003)),
  BigInt(Math.round(1e27 * 1.0005)),
  BigInt(Math.round(1e27 * 1.0007)),
  BigInt(Math.round(1e27 * 1.0009)),
]
// Synthetic lock windows per cero-exposicion: real values would let a
// reader cross-reference the on-chain contract.
const CAT_SECS: readonly bigint[] = [
  0n,
  BigInt(7 * 86400),
  BigInt(14 * 86400),
  BigInt(21 * 86400),
  BigInt(35 * 86400),
  BigInt(70 * 86400),
]

function buildFakeRpc(): NeeruIndexerRpcClient {
  const rpc: NeeruIndexerRpcClient = {
    getBlockNumber: async () => 1n,
    getBlock: async () => ({ number: 1n, timestamp: 0n }),
    getLogs: async () => [],
    multicall: (async (args: {
      contracts: ReadonlyArray<{ functionName: string; args: readonly unknown[] }>
    }) => {
      if (
        args.contracts.length === CAT_RATES.length + 2 &&
        args.contracts[0]?.functionName === 'tranches'
      ) {
        return [
          ...CAT_RATES.map((r, i) => [r, CAT_SECS[i]!, 0n, 0n] as const),
          TOKEN_DECIMALS,
          TOKEN_SYMBOL,
        ]
      }
      throw new Error(
        `unexpected multicall: ${args.contracts[0]?.functionName}`,
      )
    }) as never,
    readContract: (async (params: { functionName: string }) => {
      if (params.functionName === 'TRANCHE_COUNT') {
        return BigInt(CAT_RATES.length)
      }
      throw new Error(`readContract: unexpected ${params.functionName}`)
    }) as never,
    call: (async () => {
      throw new Error('call not used')
    }) as never,
  }
  return rpc
}

describe('GET /api/earn/neeru/catalogue', () => {
  it('returns all categories with derived monthly + annual rates', async () => {
    const { router, setRpc } = loadFreshRouter({
      NEERU_CONTRACT_ADDRESS: CONTRACT,
      NEERU_DEPOSIT_TOKEN_ADDRESS: DEPOSIT_TOKEN,
    })
    setRpc(buildFakeRpc())
    const app = express()
    app.use(router)

    const res = await request(app).get('/api/earn/neeru/catalogue')
    expect(res.status).toBe(200)
    expect(res.body.data.categories).toHaveLength(CAT_RATES.length)
    // IDs 0..N in order.
    expect(res.body.data.categories.map((c: { id: number }) => c.id)).toEqual(
      CAT_RATES.map((_, i) => i),
    )
    // Secs align with the fake's per-category lock windows.
    for (let i = 0; i < CAT_RATES.length; i++) {
      expect(res.body.data.categories[i].secs).toBe(CAT_SECS[i]!.toString())
      expect(res.body.data.categories[i].rateRay).toBe(CAT_RATES[i]!.toString())
    }
    // Monthly + annual monotonically increase with rate ray.
    const monthly = res.body.data.categories.map(
      (c: { monthlyRatePercentage: number }) => c.monthlyRatePercentage,
    )
    const annual = res.body.data.categories.map(
      (c: { annualEffectivePercentage: number }) => c.annualEffectivePercentage,
    )
    for (let i = 1; i < CAT_RATES.length; i++) {
      expect(monthly[i]).toBeGreaterThan(monthly[i - 1])
      expect(annual[i]).toBeGreaterThan(annual[i - 1])
    }
    // Deposit token surfaced with decimals + symbol from the RPC read.
    expect(res.body.data.token).toEqual({
      address: DEPOSIT_TOKEN,
      decimals: TOKEN_DECIMALS,
      symbol: TOKEN_SYMBOL,
    })
    // fetchedAt is an ISO string.
    expect(typeof res.body.data.fetchedAt).toBe('string')
    expect(new Date(res.body.data.fetchedAt).toString()).not.toBe(
      'Invalid Date',
    )
    // Wallet cache hint.
    expect(res.headers['cache-control']).toBe('public, max-age=30')
  })

  it('flexible category (secs=0) reports zero rate', async () => {
    const { router, setRpc } = loadFreshRouter({
      NEERU_CONTRACT_ADDRESS: CONTRACT,
      NEERU_DEPOSIT_TOKEN_ADDRESS: DEPOSIT_TOKEN,
    })
    setRpc(buildFakeRpc())
    const app = express()
    app.use(router)

    const res = await request(app).get('/api/earn/neeru/catalogue')
    expect(res.body.data.categories[0].monthlyRatePercentage).toBe(0)
    expect(res.body.data.categories[0].annualEffectivePercentage).toBe(0)
  })

  it('503 when hooks-api not configured', async () => {
    const { router, setRpc } = loadFreshRouter({
      NEERU_CONTRACT_ADDRESS: CONTRACT,
      NEERU_DEPOSIT_TOKEN_ADDRESS: undefined,
    })
    setRpc(buildFakeRpc())
    const app = express()
    app.use(router)

    const res = await request(app).get('/api/earn/neeru/catalogue')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('neeru not configured')
  })

  it('502 on RPC failure', async () => {
    const { router, setRpc } = loadFreshRouter({
      NEERU_CONTRACT_ADDRESS: CONTRACT,
      NEERU_DEPOSIT_TOKEN_ADDRESS: DEPOSIT_TOKEN,
    })
    const brokenRpc: NeeruIndexerRpcClient = {
      getBlockNumber: async () => 1n,
      getBlock: async () => ({ number: 1n, timestamp: 0n }),
      getLogs: async () => [],
      multicall: (async () => {
        throw new Error('rpc down')
      }) as never,
      readContract: (async () => {
        throw new Error('unused')
      }) as never,
      call: (async () => {
        throw new Error('unused')
      }) as never,
    }
    setRpc(brokenRpc)
    const app = express()
    app.use(router)

    const res = await request(app).get('/api/earn/neeru/catalogue')
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('catalogue fetch failed')
  })
})
