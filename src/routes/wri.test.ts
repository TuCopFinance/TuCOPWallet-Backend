import request from 'supertest'

const VALID_USER = '0x1234567890abcdef1234567890abcdef12345678'
const RELAY_ADDRESS = '0xfacefacefacefacefacefacefacefacefaceface'
const BATCH_EXECUTOR = '0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe'
const SAMPLE_TX_HASH =
  '0xb068ab119254432c11c0bd904a1b9ae2bf67b7d06b129b000414e3680975c137'

const mockGetTransactionCount = jest.fn()
const mockGetCode = jest.fn()
const mockGetBalance = jest.fn()
const mockSendTransaction = jest.fn()
const mockWaitForReceipt = jest.fn()
const mockRecoverAuthorizationAddress = jest.fn()

jest.mock('viem/utils', () => {
  const actual = jest.requireActual('viem/utils')
  return {
    ...actual,
    recoverAuthorizationAddress: (...args: unknown[]) =>
      mockRecoverAuthorizationAddress(...args),
  }
})

jest.mock('../lib/wriRelay', () => ({
  getRelayClients: () => ({
    account: { address: RELAY_ADDRESS },
    publicClient: {
      getTransactionCount: (...args: unknown[]) => mockGetTransactionCount(...args),
      getCode: (...args: unknown[]) => mockGetCode(...args),
      getBalance: (...args: unknown[]) => mockGetBalance(...args),
      waitForTransactionReceipt: (...args: unknown[]) => mockWaitForReceipt(...args),
    },
    walletClient: {
      chain: { id: 42220 },
      sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
    },
  }),
  _resetRelayClientsForTests: () => {},
}))

jest.mock('../lib/redis', () => ({
  getRedis: () => null,
}))

import { app } from '../app'
import { _resetInMemoryStoreForTests } from '../lib/wriRateLimit'

const BATCH_EXECUTOR_DELEGATION_CODE = `0xef0100${BATCH_EXECUTOR.toLowerCase().slice(2)}`

function validBody(overrides: Record<string, unknown> = {}) {
  const baseAuth = {
    chainId: '0xa4ec',
    address: BATCH_EXECUTOR,
    nonce: '0x5',
    yParity: '0x0',
    r: '0x' + 'aa'.repeat(32),
    s: '0x' + 'bb'.repeat(32),
  }
  const { signedAuthorization: authOverrides, ...rest } = overrides
  return {
    userAddress: VALID_USER,
    ...rest,
    signedAuthorization: {
      ...baseAuth,
      ...((authOverrides as Record<string, unknown>) ?? {}),
    },
  }
}

function setupHappyPathDefaults() {
  mockRecoverAuthorizationAddress.mockResolvedValue(VALID_USER)
  mockGetTransactionCount.mockResolvedValue(5)
  mockGetCode.mockResolvedValueOnce('0x')
  mockGetBalance.mockResolvedValue(10n * 10n ** 18n)
  mockSendTransaction.mockResolvedValue(SAMPLE_TX_HASH)
  mockWaitForReceipt.mockResolvedValue({ status: 'success' })
  mockGetCode.mockResolvedValueOnce(BATCH_EXECUTOR_DELEGATION_CODE)
}

describe('POST /api/wri/delegate-relay', () => {
  beforeEach(() => {
    mockGetTransactionCount.mockReset()
    mockGetCode.mockReset()
    mockGetBalance.mockReset()
    mockSendTransaction.mockReset()
    mockWaitForReceipt.mockReset()
    mockRecoverAuthorizationAddress.mockReset()
    _resetInMemoryStoreForTests()
  })

  it('rejects invalid userAddress', async () => {
    const body = validBody({ userAddress: '0xnothex' })
    const res = await request(app).post('/api/wri/delegate-relay').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/userAddress/i)
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects chainId !== 42220', async () => {
    const body = validBody({
      signedAuthorization: { chainId: '0x1' },
    })
    const res = await request(app).post('/api/wri/delegate-relay').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/chainId/i)
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects delegation to a non-TuCop contract address', async () => {
    const body = validBody({
      signedAuthorization: {
        address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    })
    const res = await request(app).post('/api/wri/delegate-relay').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/delegation target/i)
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects signature whose recovered signer != userAddress', async () => {
    mockRecoverAuthorizationAddress.mockResolvedValueOnce(
      '0x0000000000000000000000000000000000000bad',
    )
    const res = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/signature/i)
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects nonce mismatch (delta > 1)', async () => {
    mockRecoverAuthorizationAddress.mockResolvedValueOnce(VALID_USER)
    mockGetTransactionCount.mockResolvedValueOnce(2)
    const res = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/nonce/i)
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('returns already_delegated fast path when user is already delegated', async () => {
    mockRecoverAuthorizationAddress.mockResolvedValueOnce(VALID_USER)
    mockGetTransactionCount.mockResolvedValueOnce(5)
    mockGetCode.mockResolvedValueOnce(BATCH_EXECUTOR_DELEGATION_CODE)

    const res = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      status: 'already_delegated',
      userAddress: VALID_USER,
      delegatedTo: BATCH_EXECUTOR,
    })
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rate-limits same address within 5 min', async () => {
    setupHappyPathDefaults()
    const first = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(first.status).toBe(200)

    mockRecoverAuthorizationAddress.mockResolvedValueOnce(VALID_USER)
    mockGetTransactionCount.mockResolvedValueOnce(5)
    mockGetCode.mockResolvedValueOnce('0x')
    mockGetBalance.mockResolvedValueOnce(10n * 10n ** 18n)

    const second = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(second.status).toBe(429)
    expect(second.body.error).toMatch(/rate limited/i)
    expect(second.headers['retry-after']).toBeDefined()
  })

  it('returns 503 when relay wallet balance is below threshold', async () => {
    mockRecoverAuthorizationAddress.mockResolvedValueOnce(VALID_USER)
    mockGetTransactionCount.mockResolvedValueOnce(5)
    mockGetCode.mockResolvedValueOnce('0x')
    mockGetBalance.mockResolvedValueOnce(1000n)

    const res = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/temporarily unavailable/i)
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('happy path: submits tx, waits for receipt, verifies delegation, returns 200', async () => {
    setupHappyPathDefaults()
    const res = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      status: 'delegated',
      txHash: SAMPLE_TX_HASH,
      userAddress: VALID_USER,
      delegatedTo: BATCH_EXECUTOR,
    })

    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
    const call = mockSendTransaction.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.value).toBe(0n)
    expect(call.to).toBe(RELAY_ADDRESS)
    const authList = call.authorizationList as Array<Record<string, unknown>>
    expect(authList).toHaveLength(1)
    expect(authList[0]).toMatchObject({
      address: BATCH_EXECUTOR,
      chainId: 42220,
      nonce: 5,
      yParity: 0,
    })
  })

  it('returns 502 if receipt status is failure', async () => {
    mockRecoverAuthorizationAddress.mockResolvedValueOnce(VALID_USER)
    mockGetTransactionCount.mockResolvedValueOnce(5)
    mockGetCode.mockResolvedValueOnce('0x')
    mockGetBalance.mockResolvedValueOnce(10n * 10n ** 18n)
    mockSendTransaction.mockResolvedValueOnce(SAMPLE_TX_HASH)
    mockWaitForReceipt.mockResolvedValueOnce({ status: 'reverted' })

    const res = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/reverted/i)
  })

  it('returns 502 if post-mining code does not show our delegation', async () => {
    mockRecoverAuthorizationAddress.mockResolvedValueOnce(VALID_USER)
    mockGetTransactionCount.mockResolvedValueOnce(5)
    mockGetCode.mockResolvedValueOnce('0x')
    mockGetBalance.mockResolvedValueOnce(10n * 10n ** 18n)
    mockSendTransaction.mockResolvedValueOnce(SAMPLE_TX_HASH)
    mockWaitForReceipt.mockResolvedValueOnce({ status: 'success' })
    mockGetCode.mockResolvedValueOnce('0x')

    const res = await request(app).post('/api/wri/delegate-relay').send(validBody())
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/unverified/i)
  })
})
