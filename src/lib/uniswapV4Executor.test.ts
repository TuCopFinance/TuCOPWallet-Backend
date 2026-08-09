import { decodeFunctionData, decodeAbiParameters, hashTypedData } from 'viem'
import {
  buildPermit2TypedData,
  buildV4SwapCalldata,
  CELO_CHAIN_ID,
  PERMIT2_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
} from './uniswapV4Executor'
import { POOL_USDT_COPM } from './uniswapV4'

const USDT = POOL_USDT_COPM.currency0
const COPM = POOL_USDT_COPM.currency1
const USER = '0x1111111111111111111111111111111111111111' as `0x${string}`
const FEE_RECIPIENT =
  '0x2222222222222222222222222222222222222222' as `0x${string}`
const DUMMY_SIG = ('0x' + '11'.repeat(64) + '1b') as `0x${string}` // 65 bytes r||s||v

const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

describe('buildPermit2TypedData', () => {
  it('uses canonical Permit2 address and Celo chainId by default', () => {
    const td = buildPermit2TypedData({
      token: USDT,
      amount: 1_000_000n,
      expiration: 1_800_000_000,
      nonce: 0,
      sigDeadline: 1_700_000_000n,
    })
    expect(td.domain).toEqual({
      name: 'Permit2',
      chainId: CELO_CHAIN_ID,
      verifyingContract: PERMIT2_ADDRESS,
    })
    expect(td.primaryType).toBe('PermitSingle')
    expect(td.message.details).toEqual({
      token: USDT,
      amount: '1000000',
      expiration: 1_800_000_000,
      nonce: 0,
    })
    expect(td.message.spender).toBe(UNIVERSAL_ROUTER_ADDRESS)
    expect(td.message.sigDeadline).toBe('1700000000')
  })

  it('serializes uint160 and uint256 as decimal strings (walletJSON safe)', () => {
    const td = buildPermit2TypedData({
      token: USDT,
      amount: (1n << 160n) - 1n,
      expiration: 42,
      nonce: 7,
      sigDeadline: (1n << 256n) - 1n,
    })
    // Must be plain decimal strings, no scientific notation, no hex.
    expect(td.message.details.amount).toBe(
      ((1n << 160n) - 1n).toString(),
    )
    expect(td.message.sigDeadline).toBe(((1n << 256n) - 1n).toString())
    expect(td.message.details.expiration).toBe(42)
    expect(td.message.details.nonce).toBe(7)
  })
})

describe('buildV4SwapCalldata (envelope shape)', () => {
  beforeEach(() => {
    delete process.env.SQUID_INTEGRATOR_FEE_ADDRESS
    delete process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE
  })

  it('returns to=UniversalRouter, value=0', () => {
    const tx = buildV4SwapCalldata({
      direction: 'USDT_TO_COPM',
      recipient: USER,
      sellAmount: 1_000_000n,
      minBuyAmount: 3_200_000_000_000_000_000_000n,
      deadline: 1_700_000_030n,
      permit2Signature: DUMMY_SIG,
      permitDetails: {
        token: USDT,
        amount: 1_000_000n,
        expiration: 1_800_000_000,
        nonce: 0,
      },
      permitSigDeadline: 1_700_000_030n,
    })
    expect(tx.to).toBe(UNIVERSAL_ROUTER_ADDRESS)
    expect(tx.value).toBe(0n)
    expect(tx.data.startsWith('0x')).toBe(true)
  })

  it('encodes commands as 0x0a10 (PERMIT2_PERMIT + V4_SWAP)', () => {
    const tx = buildV4SwapCalldata({
      direction: 'USDT_TO_COPM',
      recipient: USER,
      sellAmount: 1_000_000n,
      minBuyAmount: 3_200_000_000_000_000_000_000n,
      deadline: 1_700_000_030n,
      permit2Signature: DUMMY_SIG,
      permitDetails: {
        token: USDT,
        amount: 1_000_000n,
        expiration: 1_800_000_000,
        nonce: 0,
      },
      permitSigDeadline: 1_700_000_030n,
    })
    const { functionName, args } = decodeFunctionData({
      abi: EXECUTE_ABI,
      data: tx.data,
    })
    expect(functionName).toBe('execute')
    const [commands, inputs, deadline] = args as unknown as [
      `0x${string}`,
      `0x${string}`[],
      bigint,
    ]
    expect(commands).toBe('0x0a10')
    expect(inputs).toHaveLength(2)
    expect(deadline).toBe(1_700_000_030n)
  })

  it('rejects malformed permit2Signature', () => {
    expect(() =>
      buildV4SwapCalldata({
        direction: 'USDT_TO_COPM',
        recipient: USER,
        sellAmount: 1_000_000n,
        minBuyAmount: 100n,
        deadline: 1n,
        permit2Signature: '0x1234' as `0x${string}`,
        permitDetails: { token: USDT, amount: 1n, expiration: 1, nonce: 0 },
        permitSigDeadline: 1n,
      }),
    ).toThrow(/permit2Signature/)
  })

  it('rejects sellAmount above uint128', () => {
    expect(() =>
      buildV4SwapCalldata({
        direction: 'USDT_TO_COPM',
        recipient: USER,
        sellAmount: (1n << 128n) + 1n,
        minBuyAmount: 100n,
        deadline: 1n,
        permit2Signature: DUMMY_SIG,
        permitDetails: { token: USDT, amount: 1n, expiration: 1, nonce: 0 },
        permitSigDeadline: 1n,
      }),
    ).toThrow(/sellAmount exceeds uint128/)
  })

  it('includes TAKE_PORTION action when fee env vars are set', () => {
    process.env.SQUID_INTEGRATOR_FEE_ADDRESS = FEE_RECIPIENT
    process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE = '0.5'
    const tx = buildV4SwapCalldata({
      direction: 'USDT_TO_COPM',
      recipient: USER,
      sellAmount: 1_000_000n,
      minBuyAmount: 3_000_000_000_000_000_000_000n,
      deadline: 1_700_000_030n,
      permit2Signature: DUMMY_SIG,
      permitDetails: {
        token: USDT,
        amount: 1_000_000n,
        expiration: 1_800_000_000,
        nonce: 0,
      },
      permitSigDeadline: 1_700_000_030n,
    })
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.data })
    const [, inputs] = args as unknown as [
      `0x${string}`,
      `0x${string}`[],
      bigint,
    ]
    // V4_SWAP input = abi.encode(bytes actions, bytes[] params). Decode:
    const v4Input = inputs[1]!
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      v4Input,
    ) as [`0x${string}`, `0x${string}`[]]
    // With fee: SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_PORTION + TAKE_ALL
    expect(actions).toBe('0x060c100f')
    expect(params).toHaveLength(4)
    // TAKE_PORTION params[2] = (address currency, address recipient, uint256 bips)
    const takePortionParams = params[2]!
    const [currency, recipient, bips] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      takePortionParams,
    ) as [`0x${string}`, `0x${string}`, bigint]
    expect(currency.toLowerCase()).toBe(COPM.toLowerCase())
    expect(recipient.toLowerCase()).toBe(FEE_RECIPIENT.toLowerCase())
    expect(bips).toBe(50n)
  })

  it('omits TAKE_PORTION when fee env vars are unset', () => {
    const tx = buildV4SwapCalldata({
      direction: 'USDT_TO_COPM',
      recipient: USER,
      sellAmount: 1_000_000n,
      minBuyAmount: 3_000_000_000_000_000_000_000n,
      deadline: 1_700_000_030n,
      permit2Signature: DUMMY_SIG,
      permitDetails: {
        token: USDT,
        amount: 1_000_000n,
        expiration: 1_800_000_000,
        nonce: 0,
      },
      permitSigDeadline: 1_700_000_030n,
    })
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.data })
    const [, inputs] = args as unknown as [
      `0x${string}`,
      `0x${string}`[],
      bigint,
    ]
    const v4Input = inputs[1]!
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      v4Input,
    ) as [`0x${string}`, `0x${string}`[]]
    // No fee: SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL
    expect(actions).toBe('0x060c0f')
    expect(params).toHaveLength(3)
  })

  it('COPM_TO_USDT sets zeroForOne=false + swaps currency roles', () => {
    process.env.SQUID_INTEGRATOR_FEE_ADDRESS = FEE_RECIPIENT
    process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE = '0.5'
    const tx = buildV4SwapCalldata({
      direction: 'COPM_TO_USDT',
      recipient: USER,
      sellAmount: 3_000_000_000_000_000_000_000n,
      minBuyAmount: 900_000n,
      deadline: 1_700_000_030n,
      permit2Signature: DUMMY_SIG,
      permitDetails: {
        token: COPM,
        amount: 3_000_000_000_000_000_000_000n,
        expiration: 1_800_000_000,
        nonce: 0,
      },
      permitSigDeadline: 1_700_000_030n,
    })
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: tx.data })
    const [, inputs] = args as unknown as [
      `0x${string}`,
      `0x${string}`[],
      bigint,
    ]
    const v4Input = inputs[1]!
    const [, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      v4Input,
    ) as [`0x${string}`, `0x${string}`[]]
    // TAKE_PORTION currency is the OUTPUT currency, which for COPM_TO_USDT is USDT.
    const takePortionParams = params[2]!
    const [currency] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      takePortionParams,
    ) as [`0x${string}`, `0x${string}`, bigint]
    expect(currency.toLowerCase()).toBe(USDT.toLowerCase())
  })
})

describe('typed-data reproducibility (wallet signs THIS exact hash)', () => {
  it('produces a stable hashTypedData across builds with the same inputs', () => {
    const inputs = {
      token: USDT,
      amount: 1_000_000n,
      expiration: 1_800_000_000,
      nonce: 7,
      sigDeadline: 1_700_000_030n,
    }
    const td1 = buildPermit2TypedData(inputs)
    const td2 = buildPermit2TypedData(inputs)
    // The wallet's eth_signTypedData_v4 signs this hash. Backend and wallet
    // must agree on the exact hash to sign, so this is our contract test.
    const h1 = hashTypedData({
      domain: td1.domain,
      types: td1.types,
      primaryType: 'PermitSingle',
      message: {
        details: {
          token: td1.message.details.token,
          amount: BigInt(td1.message.details.amount),
          expiration: td1.message.details.expiration,
          nonce: td1.message.details.nonce,
        },
        spender: td1.message.spender,
        sigDeadline: BigInt(td1.message.sigDeadline),
      },
    })
    const h2 = hashTypedData({
      domain: td2.domain,
      types: td2.types,
      primaryType: 'PermitSingle',
      message: {
        details: {
          token: td2.message.details.token,
          amount: BigInt(td2.message.details.amount),
          expiration: td2.message.details.expiration,
          nonce: td2.message.details.nonce,
        },
        spender: td2.message.spender,
        sigDeadline: BigInt(td2.message.sigDeadline),
      },
    })
    expect(h1).toBe(h2)
    // Sanity: hash is 32 bytes hex, not empty
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('changes the hash when any signed field changes', () => {
    const base = {
      token: USDT,
      amount: 1_000_000n,
      expiration: 1_800_000_000,
      nonce: 7,
      sigDeadline: 1_700_000_030n,
    }
    const td = buildPermit2TypedData(base)
    const hOrig = hashTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: 'PermitSingle',
      message: {
        details: {
          token: td.message.details.token,
          amount: BigInt(td.message.details.amount),
          expiration: td.message.details.expiration,
          nonce: td.message.details.nonce,
        },
        spender: td.message.spender,
        sigDeadline: BigInt(td.message.sigDeadline),
      },
    })
    // Bump nonce
    const td2 = buildPermit2TypedData({ ...base, nonce: 8 })
    const hMut = hashTypedData({
      domain: td2.domain,
      types: td2.types,
      primaryType: 'PermitSingle',
      message: {
        details: {
          token: td2.message.details.token,
          amount: BigInt(td2.message.details.amount),
          expiration: td2.message.details.expiration,
          nonce: td2.message.details.nonce,
        },
        spender: td2.message.spender,
        sigDeadline: BigInt(td2.message.sigDeadline),
      },
    })
    expect(hOrig).not.toBe(hMut)
  })
})
