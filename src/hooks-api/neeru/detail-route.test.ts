import request from 'supertest'

const USER = '0x1111111111111111111111111111111111111111'
const TX_HASH_1 =
  '0x1111111111111111111111111111111111111111111111111111111111111111'

let dbStub: { query: jest.Mock } | null = null
jest.mock('../../lib/db', () => ({
  getDb: () => dbStub,
}))

const getNeeruPositionDetailMock = jest.fn()
jest.mock('./detail', () => ({
  getNeeruPositionDetail: (args: unknown) => getNeeruPositionDetailMock(args),
}))

// Stub the other Neeru modules so unrelated routes don't fan out and
// require their own mocks/setup when this suite spins up the full app.
jest.mock('./positions', () => ({
  getNeeruEarnPositions: jest.fn(async () => []),
  getNeeruHeldPositions: jest.fn(async () => []),
}))
jest.mock('./trigger', () => ({
  buildDepositTxs: jest.fn(),
  buildWithdrawTxs: jest.fn(),
  buildWithdrawPrincipalOnlyTxs: jest.fn(),
}))
jest.mock('../../apps/allbridge', () => ({
  getPositions: jest.fn(async () => []),
  getShortcuts: jest.fn(() => []),
  triggerDeposit: jest.fn(),
  triggerWithdraw: jest.fn(),
  triggerClaimRewards: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('../../app') as typeof import('../../app')

beforeEach(() => {
  getNeeruPositionDetailMock.mockReset()
  dbStub = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }
})

describe('GET /api/earn/neeru/positions', () => {
  it('returns the detail payload for a valid address', async () => {
    getNeeruPositionDetailMock.mockResolvedValueOnce({
      address: USER,
      positions: [
        {
          positionId: '100',
          category: 1,
          categoryLabel: '7 dias',
          amount: '10000',
          accruedInterest: '82.5',
          monthlyRatePercentage: 1.0,
          startTs: 1700000000,
          endTs: 1702592000,
          depositBlock: 1234569,
          depositTxHash: TX_HASH_1,
          renewedFromPositionId: null,
          currentPayoutIfClosed: {
            amount: '10000',
            interest: '82.5',
            penaltyBps: 2000,
            interestAfterPenalty: '66',
            total: '10066',
            isEarly: true,
          },
        },
      ],
      lastSyncedBlock: 1350000,
      lastSyncedAt: '2026-06-26T15:30:00.000Z',
    })

    const res = await request(app).get(
      `/api/earn/neeru/positions?address=${USER}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data.address).toBe(USER)
    expect(res.body.data.positions).toHaveLength(1)
    expect(res.body.data.positions[0].positionId).toBe('100')
    expect(res.body.data.positions[0].depositTxHash).toBe(TX_HASH_1)
    expect(res.body.data.lastSyncedBlock).toBe(1350000)
    expect(res.body.data.lastSyncedAt).toBe('2026-06-26T15:30:00.000Z')

    expect(getNeeruPositionDetailMock).toHaveBeenCalledTimes(1)
    const args = getNeeruPositionDetailMock.mock.calls[0]?.[0]
    expect(args?.address).toBe(USER)
    expect(args?.db).toBe(dbStub)
  })

  it('400s on missing address', async () => {
    const res = await request(app).get('/api/earn/neeru/positions')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/address/i)
    expect(getNeeruPositionDetailMock).not.toHaveBeenCalled()
  })

  it('400s on a malformed address', async () => {
    const res = await request(app).get(
      '/api/earn/neeru/positions?address=nope',
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/address/i)
  })

  it('400s on a mixed-case address (lowercase-only enforcement)', async () => {
    const mixed = '0x111111111111111111111111111111111111111A'
    const res = await request(app).get(
      `/api/earn/neeru/positions?address=${mixed}`,
    )
    expect(res.status).toBe(400)
  })

  it('400s on an unknown query param', async () => {
    const res = await request(app).get(
      `/api/earn/neeru/positions?address=${USER}&bogus=1`,
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unknown param/i)
    expect(getNeeruPositionDetailMock).not.toHaveBeenCalled()
  })

  it('503s when the database is not configured', async () => {
    dbStub = null
    const res = await request(app).get(
      `/api/earn/neeru/positions?address=${USER}`,
    )
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/database/i)
    expect(getNeeruPositionDetailMock).not.toHaveBeenCalled()
  })

  it('502s and returns a non-leaking error when the assembler throws', async () => {
    getNeeruPositionDetailMock.mockRejectedValueOnce(
      new Error('rpc timeout: forno.celo.org'),
    )
    const res = await request(app).get(
      `/api/earn/neeru/positions?address=${USER}`,
    )
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('detail fetch failed')
  })
})
