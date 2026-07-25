import type { PublicClient } from 'viem'
import { buildProvisionalDeposit } from './notify'
import { CONTRACT_ADDRESS } from '../../neeru-indexer/abi'

const ORIGINAL_ENV = { ...process.env }
// Synthetic topic0 matching whatever NEERU_DEPOSIT_EVENT_TOPIC0 the test
// sets on process.env. The value below is a placeholder used only to
// route the log filter through the "match" branch of buildProvisionalDeposit.
const EVENT_TOPIC0 =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const USER = '0x1111111111111111111111111111111111111111'
const TX = '0xaabbccddeeff11223344556677889900aabbccddeeff11223344556677889900'

beforeAll(() => {
  process.env.NEERU_DEPOSIT_EVENT_TOPIC0 = EVENT_TOPIC0
})
afterAll(() => {
  process.env = { ...ORIGINAL_ENV }
})

// Encode four positional uint slots (r0..r3) as the log.data bytes.
// r0 is uint8 in the deployed event, r1..r3 are uint256; all four get
// left-padded to 32 bytes as viem's decodeAbiParameters expects.
function encodeEventData(
  r0: number,
  r1: bigint,
  r2: bigint,
  r3: bigint,
): `0x${string}` {
  const hex = (v: bigint) => v.toString(16).padStart(64, '0')
  return `0x${hex(BigInt(r0))}${hex(r1)}${hex(r2)}${hex(r3)}` as `0x${string}`
}

function padAddress(addr: string): `0x${string}` {
  return ('0x' + addr.replace(/^0x/, '').padStart(64, '0')) as `0x${string}`
}

function padPositionId(id: bigint): `0x${string}` {
  return ('0x' + id.toString(16).padStart(64, '0')) as `0x${string}`
}

function makeClient(overrides: {
  receipt?: unknown
  receiptError?: unknown
}): PublicClient {
  return {
    getTransactionReceipt: jest.fn(async () => {
      if (overrides.receiptError) throw overrides.receiptError
      return overrides.receipt
    }),
  } as unknown as PublicClient
}

const HAPPY_RECEIPT = {
  status: 'success' as const,
  blockNumber: 12345n,
  transactionHash: TX,
  logs: [
    {
      address: CONTRACT_ADDRESS,
      topics: [
        EVENT_TOPIC0,
        padAddress(USER),
        padPositionId(42n),
      ] as `0x${string}`[],
      // r0=1 (category), r1=1000e18 (amount), r2=1_700_000_000 (startTs),
      // r3=1_700_000_000 + 7d (endTs).
      data: encodeEventData(
        1,
        1_000_000_000_000_000_000_000n,
        1_700_000_000n,
        1_700_000_000n + BigInt(7 * 86400),
      ),
    },
  ],
}

describe('buildProvisionalDeposit', () => {
  it('returns a provisional position with correct fields on the happy path', async () => {
    const client = makeClient({ receipt: HAPPY_RECEIPT })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: (c) => (c === 1 ? BigInt(7 * 86400) : null),
      categoryRateRay: () => 10n ** 27n,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const p = outcome.response.position
    expect(p.provisional).toBe(true)
    expect(p.positionId).toBe('42')
    expect(p.category).toBe(1)
    expect(p.categoryLabel).toBe('7 dias')
    expect(p.amount).toBe('1000')
    expect(p.accruedInterest).toBe('0')
    expect(p.startTs).toBe(1_700_000_000)
    expect(p.endTs).toBe(1_700_000_000 + 7 * 86400)
    expect(p.depositBlock).toBe(12345)
    expect(p.depositTxHash).toBe(TX)
    expect(p.renewedFromPositionId).toBeNull()
    expect(p.currentPayoutIfClosed).toEqual({
      amount: '1000',
      interest: '0',
      penaltyBps: 0,
      interestAfterPenalty: '0',
      total: '1000',
      isEarly: false,
    })
    expect(outcome.response.address).toBe(USER.toLowerCase())
  })

  it('flags Flexible category with categoryLabel="Flexible" and endTs=startTs', async () => {
    const receipt = {
      ...HAPPY_RECEIPT,
      logs: [
        {
          address: CONTRACT_ADDRESS,
          topics: [
            EVENT_TOPIC0,
            padAddress(USER),
            padPositionId(7n),
          ] as `0x${string}`[],
          data: encodeEventData(0, 500n * 10n ** 18n, 1_700_000_000n, 0n),
        },
      ],
    }
    const client = makeClient({ receipt })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: (c) => (c === 0 ? 0n : null),
      categoryRateRay: () => 10n ** 27n,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const p = outcome.response.position
    expect(p.categoryLabel).toBe('Flexible')
    expect(p.startTs).toBe(1_700_000_000)
    expect(p.endTs).toBe(1_700_000_000)
    expect(p.amount).toBe('500')
  })

  it('returns not_configured when NEERU_DEPOSIT_EVENT_TOPIC0 is unset', async () => {
    delete process.env.NEERU_DEPOSIT_EVENT_TOPIC0
    const client = makeClient({ receipt: HAPPY_RECEIPT })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: () => null,
      categoryRateRay: () => null,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('not_configured')
    process.env.NEERU_DEPOSIT_EVENT_TOPIC0 = EVENT_TOPIC0
  })

  it('returns not_found when the RPC says receipt not found', async () => {
    const client = makeClient({
      receiptError: new Error(
        'Transaction receipt with hash "..." could not be found.',
      ),
    })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: () => null,
      categoryRateRay: () => null,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('not_found')
  })

  it('returns rpc_error on non-recoverable RPC failures', async () => {
    const client = makeClient({ receiptError: new Error('rpc timeout') })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: () => null,
      categoryRateRay: () => null,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('rpc_error')
  })

  it('returns not_deposit when the tx reverted', async () => {
    const client = makeClient({
      receipt: { ...HAPPY_RECEIPT, status: 'reverted' },
    })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: () => null,
      categoryRateRay: () => null,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('not_deposit')
  })

  it('returns not_deposit when no matching log is present', async () => {
    const client = makeClient({
      receipt: { ...HAPPY_RECEIPT, logs: [] },
    })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: () => null,
      categoryRateRay: () => null,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('not_deposit')
  })

  it('returns wrong_address when the depositor topic does not match the caller', async () => {
    const other = '0x2222222222222222222222222222222222222222'
    const receipt = {
      ...HAPPY_RECEIPT,
      logs: [
        {
          address: CONTRACT_ADDRESS,
          topics: [
            EVENT_TOPIC0,
            padAddress(other),
            padPositionId(1n),
          ] as `0x${string}`[],
          data: encodeEventData(1, 100n * 10n ** 18n, 1_700_000_000n, 0n),
        },
      ],
    }
    const client = makeClient({ receipt })
    const outcome = await buildProvisionalDeposit({
      address: USER,
      txHash: TX,
      client,
      categorySecs: () => 0n,
      categoryRateRay: () => null,
      depositDecimals: 18,
    })
    expect(outcome.kind).toBe('wrong_address')
  })
})
