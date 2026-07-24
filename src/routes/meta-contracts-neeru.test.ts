import express from 'express'
import request from 'supertest'

// Route imports env at module load, so we set env vars before requiring.
const ORIGINAL_ENV = { ...process.env }

function loadFreshApp(overrides: Record<string, string | undefined>): express.Express {
  jest.resetModules()
  process.env = { ...ORIGINAL_ENV }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const router = require('./meta-contracts-neeru').default as express.Router
  const app = express()
  app.use(router)
  return app
}

afterAll(() => {
  process.env = { ...ORIGINAL_ENV }
})

const CONTRACT = '0x988af5977201a0e988f2c75ea952532f6beb5082'
const DEPOSIT_TOPIC0 =
  '0x12ef563408f10ef4a1dde37b59a2538dcc75957c7e154bf71deea27089689653'

describe('GET /api/meta/contracts/neeru', () => {
  it('returns the full envelope when all env vars are set', async () => {
    const app = loadFreshApp({
      NEERU_CONTRACT_ADDRESS: CONTRACT,
      NEERU_DEPOSIT_EVENT_TOPIC0: DEPOSIT_TOPIC0,
      NEERU_CONTRACT_VERSION: 'v2-2026-06-30',
    })
    const res = await request(app).get('/api/meta/contracts/neeru')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      proxyAddress: CONTRACT,
      events: {
        Deposit: {
          topic0: DEPOSIT_TOPIC0,
          dataSchema: [
            { type: 'uint8' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
        },
      },
      errorSelectors: {
        INTEREST_POOL_LOW: '0x2648b779',
        ALREADY_CLOSED: '0x9acb7e52',
        NOT_OWNER: '0x30cd7471',
      },
      version: 'v2-2026-06-30',
    })
    // Cache header lets the wallet keep the metadata for a few minutes.
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('omits the Deposit entry when NEERU_DEPOSIT_EVENT_TOPIC0 is unset', async () => {
    const app = loadFreshApp({
      NEERU_CONTRACT_ADDRESS: CONTRACT,
      NEERU_DEPOSIT_EVENT_TOPIC0: undefined,
      NEERU_CONTRACT_VERSION: undefined,
    })
    const res = await request(app).get('/api/meta/contracts/neeru')
    expect(res.status).toBe(200)
    expect(res.body.events).toEqual({})
    // errorSelectors is source-of-truth in code, always present regardless
    // of env config, so the wallet always has a mapping to render from.
    expect(res.body.errorSelectors).toEqual({
      INTEREST_POOL_LOW: '0x2648b779',
      ALREADY_CLOSED: '0x9acb7e52',
      NOT_OWNER: '0x30cd7471',
    })
    expect(res.body.version).toBeNull()
  })

  it('returns null proxyAddress when NEERU_CONTRACT_ADDRESS is unset', async () => {
    const app = loadFreshApp({
      NEERU_CONTRACT_ADDRESS: undefined,
      NEERU_DEPOSIT_EVENT_TOPIC0: DEPOSIT_TOPIC0,
      NEERU_CONTRACT_VERSION: 'v2-2026-06-30',
    })
    const res = await request(app).get('/api/meta/contracts/neeru')
    expect(res.status).toBe(200)
    expect(res.body.proxyAddress).toBeNull()
    // Deposit event still surfaces because it has an independent env.
    expect(res.body.events.Deposit).toBeDefined()
  })

  it('does NOT surface UNKNOWN as an errorSelectors key', async () => {
    // UNKNOWN is the fallback reason for unmapped selectors during
    // simulation, not a contract error. It must not appear in the
    // published selector map.
    const app = loadFreshApp({
      NEERU_CONTRACT_ADDRESS: CONTRACT,
      NEERU_DEPOSIT_EVENT_TOPIC0: DEPOSIT_TOPIC0,
    })
    const res = await request(app).get('/api/meta/contracts/neeru')
    expect(res.body.errorSelectors.UNKNOWN).toBeUndefined()
  })
})
