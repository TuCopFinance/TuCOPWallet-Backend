import request from 'supertest'
import { _resetParsedEnvForTests } from '../lib/env'
import { _resetRelayClientsForTests } from '../lib/wriRelay'

const RELAY_PK =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const USER_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const ADAPTER_USDC = '0xadadadadadadadadadadadadadadadadadadadad'
const ADAPTER_USDT = '0xbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc'
const BATCH_EXECUTOR = '0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe'
const DELEGATED_CODE = `0xef0100${BATCH_EXECUTOR.slice(2).toLowerCase()}`

// Hoist mocks so they apply BEFORE app.ts (and the wri-fee-bootstrap route)
// is imported below. Per-test behaviour is set on the closure variables.

interface MockState {
  balanceByToken: Record<string, bigint>
  allowanceByToken: Record<string, bigint>
  userCode: string
  sendShouldFail: boolean
  receiptStatus: 'success' | 'reverted'
  receiptShouldThrow: boolean
}

const state: MockState = {
  balanceByToken: {},
  allowanceByToken: {},
  userCode: DELEGATED_CODE,
  sendShouldFail: false,
  receiptStatus: 'success',
  receiptShouldThrow: false,
}

jest.mock('../lib/wriRelay', () => {
  const actual = jest.requireActual('../lib/wriRelay')
  return {
    ...actual,
    getRelayClients: () => ({
      account: { address: '0xrelayrelayrelayrelayrelayrelayrelayrelay' },
      publicClient: {
        readContract: jest.fn(async (args: {
          address: string
          functionName: 'balanceOf' | 'allowance'
          args: readonly string[]
        }) => {
          const token = args.address.toLowerCase()
          if (args.functionName === 'balanceOf') {
            return state.balanceByToken[token] ?? 0n
          }
          if (args.functionName === 'allowance') {
            return state.allowanceByToken[token] ?? 0n
          }
          return 0n
        }),
        getCode: jest.fn(async () => state.userCode),
        waitForTransactionReceipt: jest.fn(async () => {
          if (state.receiptShouldThrow) throw new Error('timeout')
          return { status: state.receiptStatus }
        }),
      },
      walletClient: {
        chain: { id: 42220 },
        sendTransaction: jest.fn(async () => {
          if (state.sendShouldFail) throw new Error('rpc rejected')
          return '0xdeadbeef' + '00'.repeat(28)
        }),
      },
    }),
  }
})

beforeEach(() => {
  _resetParsedEnvForTests()
  _resetRelayClientsForTests()
  process.env.WRI_FEE_BOOTSTRAP_ENABLED = 'true'
  process.env.WRI_FEE_ADAPTER_USDC = ADAPTER_USDC
  process.env.WRI_FEE_ADAPTER_USDT = ADAPTER_USDT
  process.env.WRI_RELAY_PK = RELAY_PK
  process.env.ETHERSCAN_API_KEY = 'test-key'
  state.balanceByToken = {}
  state.allowanceByToken = {}
  state.userCode = DELEGATED_CODE
  state.sendShouldFail = false
  state.receiptStatus = 'success'
  state.receiptShouldThrow = false
})

import { app } from '../app'

describe('POST /api/wri/fee-adapter-bootstrap', () => {
  it('returns 503 when the kill switch is off', async () => {
    process.env.WRI_FEE_BOOTSTRAP_ENABLED = 'false'
    _resetParsedEnvForTests()
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('fee bootstrap disabled')
  })

  it('rejects invalid address', async () => {
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: 'not-an-address' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid address')
  })

  it('returns 412 when the user is not delegated to BatchExecutor', async () => {
    state.userCode = '0x'
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(412)
    expect(res.body.error).toContain('precondition failed')
  })

  it('returns approved status for USDC when balance>0 and allowance below threshold', async () => {
    state.balanceByToken[USDC] = 1_000_000n // 1 USDC (6 decimals)
    state.allowanceByToken[USDC] = 0n
    state.balanceByToken[USDT] = 0n
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const usdc = res.body.results.find(
      (r: { tokenSymbol: string }) => r.tokenSymbol === 'USDC',
    )
    expect(usdc.status).toBe('approved')
    expect(usdc.alreadyApproved).toBe(false)
    expect(usdc.txHash).toMatch(/^0x[0-9a-f]+$/)
    expect(usdc.adapterAddress).toBe(ADAPTER_USDC)
  })

  it('returns already_approved when allowance is above the threshold', async () => {
    const above = (1n << 200n) + 1n
    state.balanceByToken[USDC] = 1_000_000n
    state.allowanceByToken[USDC] = above
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(200)
    const usdc = res.body.results.find(
      (r: { tokenSymbol: string }) => r.tokenSymbol === 'USDC',
    )
    expect(usdc.status).toBe('already_approved')
    expect(usdc.alreadyApproved).toBe(true)
    expect(usdc.txHash).toBeNull()
  })

  it('returns skipped_no_balance when user has zero of the token', async () => {
    state.balanceByToken[USDC] = 0n
    state.balanceByToken[USDT] = 0n
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(200)
    const usdc = res.body.results.find(
      (r: { tokenSymbol: string }) => r.tokenSymbol === 'USDC',
    )
    expect(usdc.status).toBe('skipped_no_balance')
  })

  it('returns skipped_no_adapter when env var is unset', async () => {
    delete process.env.WRI_FEE_ADAPTER_USDC
    _resetParsedEnvForTests()
    state.balanceByToken[USDC] = 1_000_000n
    state.balanceByToken[USDT] = 0n
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(200)
    const usdc = res.body.results.find(
      (r: { tokenSymbol: string }) => r.tokenSymbol === 'USDC',
    )
    expect(usdc.status).toBe('skipped_no_adapter')
  })

  it('returns relay_failed when sendTransaction throws', async () => {
    state.balanceByToken[USDC] = 1_000_000n
    state.allowanceByToken[USDC] = 0n
    state.sendShouldFail = true
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(200)
    const usdc = res.body.results.find(
      (r: { tokenSymbol: string }) => r.tokenSymbol === 'USDC',
    )
    expect(usdc.status).toBe('relay_failed')
    expect(usdc.txHash).toBeNull()
  })

  it('returns relay_failed when receipt reports revert', async () => {
    state.balanceByToken[USDC] = 1_000_000n
    state.allowanceByToken[USDC] = 0n
    state.receiptStatus = 'reverted'
    const res = await request(app)
      .post('/api/wri/fee-adapter-bootstrap')
      .send({ address: USER_ADDRESS })
    expect(res.status).toBe(200)
    const usdc = res.body.results.find(
      (r: { tokenSymbol: string }) => r.tokenSymbol === 'USDC',
    )
    expect(usdc.status).toBe('relay_failed')
    expect(usdc.txHash).toMatch(/^0x[0-9a-f]+$/)
  })
})
