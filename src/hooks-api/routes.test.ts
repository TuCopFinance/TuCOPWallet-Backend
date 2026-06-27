import request from 'supertest'

const USER = '0x1111111111111111111111111111111111111111'

// Mock the DB and the two app modules BEFORE importing app.
let dbStub: { query: jest.Mock } | null = null
jest.mock('../lib/db', () => ({
  getDb: () => dbStub,
}))

const allbridgeGetPositionsMock = jest.fn()
const allbridgeGetShortcutsMock = jest.fn()
const allbridgeTriggerDepositMock = jest.fn()
const allbridgeTriggerWithdrawMock = jest.fn()
const allbridgeTriggerClaimRewardsMock = jest.fn()
jest.mock('../apps/allbridge', () => ({
  getPositions: (args: unknown) => allbridgeGetPositionsMock(args),
  getShortcuts: () => allbridgeGetShortcutsMock(),
  triggerDeposit: (args: unknown) => allbridgeTriggerDepositMock(args),
  triggerWithdraw: (args: unknown) => allbridgeTriggerWithdrawMock(args),
  triggerClaimRewards: (args: unknown) => allbridgeTriggerClaimRewardsMock(args),
}))

const neeruGetEarnPositionsMock = jest.fn()
const neeruGetHeldPositionsMock = jest.fn()
jest.mock('./neeru/positions', () => ({
  getNeeruEarnPositions: (args: unknown) => neeruGetEarnPositionsMock(args),
  getNeeruHeldPositions: (args: unknown) => neeruGetHeldPositionsMock(args),
}))

const neeruBuildDepositTxsMock = jest.fn()
const neeruBuildWithdrawTxsMock = jest.fn()
const neeruBuildWithdrawPrincipalOnlyTxsMock = jest.fn()
jest.mock('./neeru/trigger', () => ({
  buildDepositTxs: (args: unknown) => neeruBuildDepositTxsMock(args),
  buildWithdrawTxs: (args: unknown) => neeruBuildWithdrawTxsMock(args),
  buildWithdrawPrincipalOnlyTxs: (args: unknown) =>
    neeruBuildWithdrawPrincipalOnlyTxsMock(args),
}))

// app must be imported AFTER the mocks above so the router pulls the
// mocked modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('../app') as typeof import('../app')

function buildAllbridgeApp(positionId: string) {
  return {
    type: 'app-token',
    positionId,
    address: '0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af',
    networkId: 'celo-mainnet',
    appId: 'allbridge',
    appName: 'Allbridge',
    label: 'USDC',
    displayProps: {
      title: 'USDC',
      description: 'Supplied',
      imageUrl: 'https://example/logo.png',
      manageUrl: 'https://core.allbridge.io/pools',
    },
    tokens: [],
    availableShortcutIds: ['deposit', 'withdraw'],
    shortcutTriggerArgs: {},
    symbol: 'USDC',
    decimals: 6,
    priceUsd: '0',
    balance: '100',
    supply: '1000',
    pricePerShare: ['1'],
  }
}

function buildNeeruApp(category: number, balance = '0') {
  return {
    type: 'app-token',
    positionId: `celo-mainnet:0x000000000000000000000000000000000000beef:tranche-${category}`,
    address: '0x000000000000000000000000000000000000beef',
    networkId: 'celo-mainnet',
    appId: 'neeru-vaults',
    appName: 'Neeru Vaults',
    label: 'Flexible',
    displayProps: {
      title: 'Flexible',
      description: 'desc',
      imageUrl: '',
      manageUrl: '',
    },
    tokens: [],
    availableShortcutIds: ['deposit', 'withdraw'],
    shortcutTriggerArgs: {
      deposit: { trancheId: category },
      withdraw: { trancheId: category },
    },
    symbol: 'COPm',
    decimals: 18,
    priceUsd: '0',
    balance,
    supply: balance,
    pricePerShare: ['1'],
  }
}

beforeEach(() => {
  allbridgeGetPositionsMock.mockReset()
  allbridgeGetShortcutsMock.mockReset()
  allbridgeTriggerDepositMock.mockReset()
  allbridgeTriggerWithdrawMock.mockReset()
  allbridgeTriggerClaimRewardsMock.mockReset()
  neeruGetEarnPositionsMock.mockReset()
  neeruGetHeldPositionsMock.mockReset()
  neeruBuildDepositTxsMock.mockReset()
  neeruBuildWithdrawTxsMock.mockReset()
  neeruBuildWithdrawPrincipalOnlyTxsMock.mockReset()
  dbStub = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }
})

describe('GET /hooks-api/getPositions', () => {
  it('400s on invalid address', async () => {
    const res = await request(app).get('/hooks-api/getPositions?address=nope')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/address/i)
  })

  it('merges allbridge + neeru held positions for a valid address', async () => {
    allbridgeGetPositionsMock.mockResolvedValueOnce([
      buildAllbridgeApp(
        'celo-mainnet:0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af',
      ),
    ])
    neeruGetHeldPositionsMock.mockResolvedValueOnce([buildNeeruApp(1, '50')])

    const res = await request(app).get(
      `/hooks-api/getPositions?address=${USER}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].appId).toBe('allbridge')
    expect(res.body.data[1].appId).toBe('neeru-vaults')
  })

  it('still returns Neeru if allbridge throws', async () => {
    allbridgeGetPositionsMock.mockRejectedValueOnce(new Error('boom'))
    neeruGetHeldPositionsMock.mockResolvedValueOnce([buildNeeruApp(0, '10')])

    const res = await request(app).get(
      `/hooks-api/getPositions?address=${USER}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].appId).toBe('neeru-vaults')
  })

  it('returns Allbridge-only when DATABASE_URL is unset', async () => {
    dbStub = null
    allbridgeGetPositionsMock.mockResolvedValueOnce([
      buildAllbridgeApp(
        'celo-mainnet:0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af',
      ),
    ])
    const res = await request(app).get(
      `/hooks-api/getPositions?address=${USER}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].appId).toBe('allbridge')
    expect(neeruGetHeldPositionsMock).not.toHaveBeenCalled()
  })
})

describe('GET /hooks-api/getEarnPositions', () => {
  it('returns the full catalogue without an address', async () => {
    allbridgeGetPositionsMock.mockResolvedValueOnce([
      buildAllbridgeApp(
        'celo-mainnet:0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af',
      ),
    ])
    neeruGetEarnPositionsMock.mockResolvedValueOnce([
      buildNeeruApp(0),
      buildNeeruApp(1),
      buildNeeruApp(2),
      buildNeeruApp(3),
    ])

    const res = await request(app).get('/hooks-api/getEarnPositions')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(5)
    expect(
      res.body.data.map((p: { appId: string }) => p.appId).sort(),
    ).toEqual(['allbridge', 'neeru-vaults', 'neeru-vaults', 'neeru-vaults', 'neeru-vaults'])
  })

  it('filters by supportedAppIds=neeru-vaults', async () => {
    neeruGetEarnPositionsMock.mockResolvedValueOnce([
      buildNeeruApp(0),
      buildNeeruApp(1),
    ])
    const res = await request(app).get(
      '/hooks-api/getEarnPositions?supportedAppIds=neeru-vaults',
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(allbridgeGetPositionsMock).not.toHaveBeenCalled()
  })

  it('filters by supportedPools positionId list', async () => {
    neeruGetEarnPositionsMock.mockResolvedValueOnce([
      buildNeeruApp(0),
      buildNeeruApp(1),
      buildNeeruApp(2),
      buildNeeruApp(3),
    ])
    const targetId =
      'celo-mainnet:0x000000000000000000000000000000000000beef:tranche-2'
    const res = await request(app).get(
      `/hooks-api/getEarnPositions?supportedAppIds=neeru-vaults&supportedPools=${encodeURIComponent(targetId)}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].positionId).toBe(targetId)
  })

  it('400s on invalid address', async () => {
    const res = await request(app).get(
      '/hooks-api/getEarnPositions?address=nope',
    )
    expect(res.status).toBe(400)
  })

  it('passes the validated address through to the app modules', async () => {
    allbridgeGetPositionsMock.mockResolvedValueOnce([])
    neeruGetEarnPositionsMock.mockResolvedValueOnce([])
    await request(app).get(`/hooks-api/getEarnPositions?address=${USER}`)
    expect(allbridgeGetPositionsMock).toHaveBeenCalledWith({
      networkId: 'celo-mainnet',
      address: USER,
    })
    const neeruCall = neeruGetEarnPositionsMock.mock.calls[0]?.[0]
    expect(neeruCall?.address).toBe(USER)
  })

  it('skips Neeru when DATABASE_URL unset, still calls Allbridge', async () => {
    dbStub = null
    allbridgeGetPositionsMock.mockResolvedValueOnce([
      buildAllbridgeApp(
        'celo-mainnet:0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af',
      ),
    ])
    const res = await request(app).get('/hooks-api/getEarnPositions')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(neeruGetEarnPositionsMock).not.toHaveBeenCalled()
  })

  it('400s on unsupported networkIds', async () => {
    const res = await request(app).get(
      '/hooks-api/getEarnPositions?networkIds=mars-mainnet',
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /hooks-api/v2/getShortcuts', () => {
  it('returns allbridge + neeru shortcuts merged', async () => {
    allbridgeGetShortcutsMock.mockReturnValueOnce([
      {
        id: 'deposit',
        appId: 'allbridge',
        name: 'Deposit',
        description: 'Lend your assets to earn interest',
        networkIds: ['celo-mainnet'],
        category: 'deposit',
      },
    ])

    const res = await request(app).get('/hooks-api/v2/getShortcuts')
    expect(res.status).toBe(200)
    const ids = res.body.data.map(
      (s: { appId: string; id: string }) => `${s.appId}:${s.id}`,
    )
    expect(ids).toContain('allbridge:deposit')
    expect(ids).toContain('neeru-vaults:deposit')
    expect(ids).toContain('neeru-vaults:withdraw')
    expect(ids).toContain('neeru-vaults:withdraw-principal-only')
  })

  it('400s on unsupported networkIds', async () => {
    const res = await request(app).get(
      '/hooks-api/v2/getShortcuts?networkIds=mars-mainnet',
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /hooks-api/triggerShortcut', () => {
  const SAMPLE_TX = {
    to: '0x000000000000000000000000000000000000beef',
    data: '0xdeadbeef',
    value: '0',
    networkId: 'celo-mainnet',
  }

  it('400s when address is missing', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/address/i)
  })

  it('400s on a malformed address', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: 'not-an-address',
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/address/i)
  })

  it('400s on an unsupported networkId', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'ethereum-mainnet',
        shortcutId: 'deposit',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/networkId/i)
  })

  it('400s on an unknown appId', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'bogus',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/appId/i)
  })

  it('400s on an unknown shortcutId for Neeru', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'mystery',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/shortcut/i)
  })

  it('happy-path Neeru deposit returns transactions + dataProps', async () => {
    neeruBuildDepositTxsMock.mockResolvedValueOnce({
      transactions: [SAMPLE_TX, SAMPLE_TX],
    })
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
        trancheId: 1,
        tokens: [
          {
            tokenId: 'celo-mainnet:0x000000000000000000000000000000000000c0fe',
            amount: '500',
          },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.data.transactions).toHaveLength(2)
    expect(res.body.data.dataProps).toEqual({})
    expect(neeruBuildDepositTxsMock).toHaveBeenCalledTimes(1)
    const args = neeruBuildDepositTxsMock.mock.calls[0]?.[0]
    expect(args?.address).toBe(USER)
    expect(args?.trancheId).toBe(1)
    expect(args?.amount).toBe('500')
  })

  it('happy-path Neeru withdraw returns the single closePosition tx', async () => {
    neeruBuildWithdrawTxsMock.mockResolvedValueOnce({
      transactions: [SAMPLE_TX],
    })
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'withdraw',
        positionId: '42',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.transactions).toHaveLength(1)
    expect(neeruBuildWithdrawTxsMock).toHaveBeenCalledTimes(1)
  })

  it('happy-path Neeru withdraw-principal-only returns the single tx', async () => {
    neeruBuildWithdrawPrincipalOnlyTxsMock.mockResolvedValueOnce({
      transactions: [SAMPLE_TX],
    })
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'withdraw-principal-only',
        positionId: '42',
      })
    expect(res.status).toBe(200)
    expect(res.body.data.transactions).toHaveLength(1)
    expect(neeruBuildWithdrawPrincipalOnlyTxsMock).toHaveBeenCalledTimes(1)
  })

  it('maps documented Neeru error codes to 400 with the code in the body', async () => {
    neeruBuildDepositTxsMock.mockRejectedValueOnce(
      new Error('TRANCHE_CAP_EXCEEDED'),
    )
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
        trancheId: 1,
        tokens: [{ tokenId: 'x', amount: '500' }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('TRANCHE_CAP_EXCEEDED')
  })

  it('maps a generic error to 502 with a non-leaking message', async () => {
    neeruBuildDepositTxsMock.mockRejectedValueOnce(
      new Error('rpc timeout: forno.celo.org'),
    )
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
        trancheId: 1,
        tokens: [{ tokenId: 'x', amount: '500' }],
      })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('shortcut build failed')
  })

  it('happy-path Allbridge deposit forwards to triggerDeposit', async () => {
    allbridgeTriggerDepositMock.mockResolvedValueOnce({
      transactions: [SAMPLE_TX],
    })
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'allbridge',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
        positionAddress: '0xfb2c7c10e731ebe96dabdf4a96d656bfe8e2b5af',
        tokenAddress: '0xceba9300f2b948710d2653dd7b07f33a8b32118c',
        tokenDecimals: 6,
        tokens: [{ amount: '1.5' }],
      })
    expect(res.status).toBe(200)
    expect(res.body.data.transactions).toHaveLength(1)
    expect(allbridgeTriggerDepositMock).toHaveBeenCalledTimes(1)
  })

  it('400s on an unknown shortcutId for Allbridge', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'allbridge',
        networkId: 'celo-mainnet',
        shortcutId: 'mystery',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/shortcut/i)
  })

  it('400s when Neeru deposit body is missing the tokens array', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'deposit',
        trancheId: 1,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/tokens/i)
  })

  it('400s when Neeru withdraw body has a non-numeric positionId', async () => {
    const res = await request(app)
      .post('/hooks-api/triggerShortcut')
      .send({
        address: USER,
        appId: 'neeru-vaults',
        networkId: 'celo-mainnet',
        shortcutId: 'withdraw',
        positionId: 'abc',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/positionId/i)
  })
})
