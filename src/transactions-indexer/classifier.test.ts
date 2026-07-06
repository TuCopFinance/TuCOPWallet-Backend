import { _resetParsedEnvForTests } from '../lib/env'
import { _resetEarnRegistryForTests, classify } from './classifier'
import type { ClassifierLog, ClassifierTx, EarnTransaction, SwapTransaction } from './types'

const USER = '0x1111111111111111111111111111111111111111'
const COUNTERPARTY = '0x2222222222222222222222222222222222222222'
const SQUID_ROUTER = '0xce16f69375520ab01377ce7b88f5ba8c48f8d666'

const TOKEN_USDM = '0x765de816845861e75a25fca122bb6898b8b1282a'
const TOKEN_USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const TOKEN_USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const TOKEN_COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'

const ERC20_TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function addrTopic(a: string): string {
  return '0x' + '0'.repeat(24) + a.slice(2).toLowerCase()
}

function uintData(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0')
}

function addrArg(a: string): string {
  return '0'.repeat(24) + a.slice(2).toLowerCase()
}

function uintArg(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

function baseTx(overrides: Partial<ClassifierTx> = {}): ClassifierTx {
  return {
    networkId: 'celo-mainnet',
    hash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    blockNumber: 1000n,
    blockTimestampMs: 1_700_000_000_000,
    txIndex: 0,
    from: USER,
    to: COUNTERPARTY,
    valueWei: 0n,
    status: 'success',
    gasUsed: 100_000n,
    effectiveGasPrice: 5_000_000_000n,
    feeCurrency: null,
    input: '0x',
    ...overrides,
  }
}

function transferLog(opts: {
  logIndex: number
  contract: string
  from: string
  to: string
  value: bigint
}): ClassifierLog {
  return {
    logIndex: opts.logIndex,
    contract: opts.contract,
    topic0: ERC20_TRANSFER_TOPIC0,
    topic1: addrTopic(opts.from),
    topic2: addrTopic(opts.to),
    topic3: null,
    data: uintData(opts.value),
  }
}

describe('classify', () => {
  it('rule 1: 7702 atomic batch with multiple sold tokens and one received token', () => {
    // Real v2 spike tx, BatchExecutor 0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe.
    // tx.from == tx.to == USER, input starts with execute() selector 0x3f707e6b.
    const tx = baseTx({
      hash: '0xbefe73327f874c2e60ef95939499ecbb72c2a61478eb20f011ff9e4d745be5d8',
      from: USER,
      to: USER,
      input: '0x3f707e6b' + '00'.repeat(32),
    })

    const logs: ClassifierLog[] = [
      // sold: USDm, USDC, USDT
      transferLog({ logIndex: 0, contract: TOKEN_USDM, from: USER, to: SQUID_ROUTER, value: 100n }),
      transferLog({ logIndex: 1, contract: TOKEN_USDC, from: USER, to: SQUID_ROUTER, value: 200n }),
      transferLog({ logIndex: 2, contract: TOKEN_USDT, from: USER, to: SQUID_ROUTER, value: 300n }),
      // received: COPm (the single output)
      transferLog({ logIndex: 3, contract: TOKEN_COPM, from: SQUID_ROUTER, to: USER, value: 999n }),
    ]

    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    const swap = out[0] as SwapTransaction
    expect(swap.type).toBe('SWAP_TRANSACTION')
    expect(swap.status).toBe('Complete')
    expect(swap.inAmount.tokenId).toBe(`celo-mainnet:${TOKEN_COPM}`)
    // COPm is 18 decimals. 999 wei -> "0.000000000000000999" (padded).
    expect(swap.inAmount.value).toBe('0.000000000000000999')
    expect(swap.inAmount.decimals).toBe(18)
    // USDT (6 decimals) wins pickHighest on raw wei (300 > 200 > 100).
    expect(swap.outAmount.tokenId).toBe(`celo-mainnet:${TOKEN_USDT}`)
    expect(swap.outAmount.value).toBe('0.000300')
    expect(swap.outAmount.decimals).toBe(6)
    expect(swap.fromTokenAmounts).toHaveLength(3)
    const fromTokens = (swap.fromTokenAmounts ?? []).map((a) => a.tokenId).sort()
    expect(fromTokens).toEqual(
      [TOKEN_USDM, TOKEN_USDC, TOKEN_USDT].map((c) => `celo-mainnet:${c}`).sort(),
    )
  })

  it('rule 2: plain aggregator swap (single in, single out) returns SWAP_TRANSACTION without fromTokenAmounts', () => {
    const tx = baseTx({
      from: USER,
      to: SQUID_ROUTER,
      input: '0x12345678' + '00'.repeat(32),
    })
    const logs: ClassifierLog[] = [
      transferLog({ logIndex: 0, contract: TOKEN_USDM, from: USER, to: SQUID_ROUTER, value: 1000n }),
      transferLog({ logIndex: 1, contract: TOKEN_COPM, from: SQUID_ROUTER, to: USER, value: 4_000_000n }),
    ]
    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    const swap = out[0] as SwapTransaction
    expect(swap.type).toBe('SWAP_TRANSACTION')
    expect(swap.outAmount.tokenId).toBe(`celo-mainnet:${TOKEN_USDM}`)
    expect(swap.inAmount.tokenId).toBe(`celo-mainnet:${TOKEN_COPM}`)
    expect(swap.fromTokenAmounts).toBeUndefined()
  })

  it('rule 3: ERC20 approve returns APPROVAL', () => {
    const tx = baseTx({
      from: USER,
      to: TOKEN_USDM,
      input: '0x095ea7b3' + addrArg(SQUID_ROUTER) + uintArg(1n << 200n),
    })
    const out = classify(tx, [], USER)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('APPROVAL')
    const ap = out[0] as { type: 'APPROVAL'; approvedAddress: string; tokenId: string }
    expect(ap.approvedAddress).toBe(SQUID_ROUTER)
    expect(ap.tokenId).toBe(`celo-mainnet:${TOKEN_USDM}`)
  })

  it('rule 4: ERC20 transfer returns SENT', () => {
    const tx = baseTx({
      from: USER,
      to: TOKEN_USDM,
      input: '0xa9059cbb' + addrArg(COUNTERPARTY) + uintArg(500n),
    })
    const out = classify(tx, [], USER)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('SENT')
    const t = out[0] as { type: 'SENT'; amount: { tokenId: string; value: string; decimals: number | null }; address: string; status: string }
    expect(t.amount.value).toBe('0.000000000000000500')
    expect(t.amount.decimals).toBe(18)
    expect(t.amount.tokenId).toBe(`celo-mainnet:${TOKEN_USDM}`)
    expect(t.address).toBe(COUNTERPARTY)
    expect(t.status).toBe('Complete')
  })

  it('rule 4: ERC20 transferFrom where user is the `to` returns RECEIVED', () => {
    const tx = baseTx({
      from: USER,
      to: TOKEN_USDM,
      input: '0x23b872dd' + addrArg(COUNTERPARTY) + addrArg(USER) + uintArg(700n),
    })
    const out = classify(tx, [], USER)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('RECEIVED')
  })

  it('rule 5: native CELO send (input is empty, value > 0) returns SENT CELO at its ERC20 contract id', () => {
    const tx = baseTx({
      from: USER,
      to: COUNTERPARTY,
      valueWei: 5_000_000_000_000_000_000n,
      input: '0x',
    })
    const out = classify(tx, [], USER)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('SENT')
    const t = out[0] as { type: 'SENT'; amount: { tokenId: string; value: string } }
    // CELO has an ERC20 contract on Celo; the wallet registry keys off the
    // contract id, not a `:native` sentinel.
    expect(t.amount.tokenId).toBe(
      'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438',
    )
    expect(t.amount.value).toBe('5.000000000000000000')
  })

  it('rule 6: receive via Transfer log when user is not the initiator returns RECEIVED', () => {
    const tx = baseTx({
      from: COUNTERPARTY,
      to: TOKEN_USDM,
      input: '0xa9059cbb' + addrArg(USER) + uintArg(1234n),
    })
    const logs: ClassifierLog[] = [
      transferLog({ logIndex: 0, contract: TOKEN_USDM, from: COUNTERPARTY, to: USER, value: 1234n }),
    ]
    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('RECEIVED')
    const t = out[0] as { type: 'RECEIVED'; amount: { tokenId: string; value: string } }
    expect(t.amount.value).toBe('0.000000000000001234')
  })

  // Post-2026-07-05: reverted txs surface with status: 'Failed' instead of
  // being dropped, so the wallet timeline can show attempted actions.
  it('reverted native send is emitted with status: Failed', () => {
    const tx = baseTx({
      status: 'reverted',
      valueWei: 1n,
      from: USER,
      to: COUNTERPARTY,
      input: '0x',
    })
    const out = classify(tx, [], USER)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('SENT')
    expect(out[0]?.status).toBe('Failed')
  })

  // Regression fixture for Bug 2 (2026-07-05) + Bug 4 (2026-07-06) + Option B
  // (2026-07-06). Reproduces the wallet team's spike v2 tx 0xb5d1cb4aef... -
  // a COPm -> USDm Mento swap with fee paid in COPm via CIP-64. Verifies:
  //
  //   - Bug 2: inAmount and outAmount classify to distinct tokens (not both
  //     COPm as pre-fix pickHighest emitted due to the mirror mint refund).
  //   - Option B: outAmount value is the SWAP LEG ONLY (log[1] = 3502.55),
  //     not the sum of swap + burn + fees + refund. Matches Valora shape
  //     for continuity with users' Valora screenshots.
  //   - Bug 4: fees[0].amount.tokenId reflects `tx.feeCurrency` (COPm here),
  //     not the always-CELO fallback that pre-fix persistTx wrote due to a
  //     hardcoded null.
  it('rule 2 + option B: Mento swap with mirror refund + CIP-64 fee', () => {
    const MENTO_POOL = '0x3333333333333333333333333333333333333333'
    const BROKER = '0x4444444444444444444444444444444444444444'
    const FEE_SINK = '0x5555555555555555555555555555555555555555'
    const AGG_FEE = '0x6666666666666666666666666666666666666666'
    const BURN = '0x0000000000000000000000000000000000000000'
    const tx = baseTx({
      hash: '0xb5d1cb4aef7821c7359c16937c290d091f8b5d43760afdf891985137ef418781',
      from: USER,
      to: SQUID_ROUTER,
      input: '0x12345678' + '00'.repeat(32),
      // CIP-64 tx paying gas in COPm. Pre-Bug-4, persistTx wrote null here
      // regardless of the on-chain value and the classifier emitted CELO;
      // now feeCurrency flows through and the fee row is labeled COPm.
      feeCurrency: TOKEN_COPM,
    })
    const swapOut = 3_502_550_000_000_000_000_000n // 3502.55 COPm to pool (swap leg)
    const refund = 32_189_703_752_759_390_600n // 32.189... COPm burn + mirror mint
    const swapIn = 1_013_769_540_000_000_000n // 1.013 USDm from pool
    const feeSmall = 1_237_994_800_000_000_000n // 1.237 COPm fee (out to fee sink)
    const feeAgg = 14_630_401_209_248_830_000n // 14.63 COPm agg fee (out to agg)
    const logs: ClassifierLog[] = [
      transferLog({ logIndex: 0, contract: TOKEN_COPM, from: USER, to: BURN, value: refund }),
      transferLog({ logIndex: 1, contract: TOKEN_COPM, from: USER, to: MENTO_POOL, value: swapOut }),
      transferLog({ logIndex: 2, contract: TOKEN_COPM, from: MENTO_POOL, to: BROKER, value: swapOut }),
      transferLog({ logIndex: 3, contract: TOKEN_COPM, from: BROKER, to: BURN, value: swapOut }),
      transferLog({ logIndex: 4, contract: TOKEN_USDM, from: BURN, to: MENTO_POOL, value: swapIn }),
      transferLog({ logIndex: 5, contract: TOKEN_USDM, from: MENTO_POOL, to: USER, value: swapIn }),
      transferLog({ logIndex: 6, contract: TOKEN_COPM, from: BURN, to: USER, value: refund }),
      transferLog({ logIndex: 7, contract: TOKEN_COPM, from: USER, to: FEE_SINK, value: feeSmall }),
      transferLog({ logIndex: 8, contract: TOKEN_COPM, from: USER, to: AGG_FEE, value: feeAgg }),
    ]
    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    const swap = out[0] as SwapTransaction
    expect(swap.type).toBe('SWAP_TRANSACTION')
    // Bug 2 still fixed.
    expect(swap.outAmount.tokenId).toBe(`celo-mainnet:${TOKEN_COPM}`)
    expect(swap.inAmount.tokenId).toBe(`celo-mainnet:${TOKEN_USDM}`)
    expect(swap.inAmount.value).toBe('1.013769540000000000')
    // Option B: outAmount is the SWAP LEG only (log[1] = 3502.55 COPm),
    // not the sum of swap + burn + fees + refund (3550.61 COPm).
    expect(swap.outAmount.value).toBe('3502.550000000000000000')
    // Bug 4: fee row labeled with COPm (feeCurrency), not CELO.
    expect(swap.fees).toHaveLength(1)
    expect(swap.fees[0]?.amount.tokenId).toBe(`celo-mainnet:${TOKEN_COPM}`)
    expect(swap.fees[0]?.amount.decimals).toBe(18)
  })

  // Bug 4 sub-case: adapter-only fee currency (USDC / USDT). The tx pays
  // gas via the USDC fee-currency adapter contract. The classifier must
  // surface the underlying USDC token on the fees row, downshifted from
  // the adapter's 18-decimal normalised units to USDC's 6-decimal native
  // scale, so the wallet renders "you paid X USDC in gas".
  it('bug 4: CIP-64 fee via USDC adapter -> underlying USDC on fees[]', () => {
    const USDC_ADAPTER = '0x2f25deb3848c207fc8e0c34035b3ba7fc157602b'
    const USDC_UNDERLYING = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
    const tx = baseTx({
      from: USER,
      to: COUNTERPARTY,
      // 200_000 gas x 5 gwei-equivalent-in-adapter-units = 1e15 wei (18-normalised)
      // = 0.001 in underlying USDC terms (6 decimals).
      gasUsed: 200_000n,
      effectiveGasPrice: 5_000_000_000n,
      feeCurrency: USDC_ADAPTER,
      input: '0xa9059cbb' + addrArg(COUNTERPARTY) + uintArg(1n),
    })
    const out = classify(tx, [], USER)
    expect(out).toHaveLength(1)
    const fee = out[0]?.fees[0]?.amount
    expect(fee?.tokenId).toBe(`celo-mainnet:${USDC_UNDERLYING}`)
    expect(fee?.decimals).toBe(6)
    // 200000 * 5e9 = 1e15 raw (18-normalised) / 1e12 = 1000 (6-dec raw) = 0.001000 USDC padded
    expect(fee?.value).toBe('0.001000')
  })

  it('unrecognized contract call by user with no Transfer logs returns []', () => {
    const tx = baseTx({
      from: USER,
      to: COUNTERPARTY,
      input: '0xdeadbeef',
    })
    expect(classify(tx, [], USER)).toEqual([])
  })

  it('tx user did not originate and no Transfer-to-user logs returns []', () => {
    const tx = baseTx({
      from: COUNTERPARTY,
      to: SQUID_ROUTER,
      input: '0xdeadbeef',
    })
    expect(classify(tx, [], USER)).toEqual([])
  })
})

describe('classify - Earn / Neeru event classification', () => {
  const NEERU_CONTRACT = '0x3333333333333333333333333333333333333333'
  const NEERU_EVENT_A =
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const NEERU_EVENT_B =
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const NEERU_EVENT_C =
    '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'

  function setNeeruEnv({ withDepositToken = true }: { withDepositToken?: boolean } = {}): void {
    process.env.NEERU_CONTRACT_ADDRESS = NEERU_CONTRACT
    process.env.NEERU_EVENT_A_TOPIC0 = NEERU_EVENT_A
    process.env.NEERU_EVENT_B_TOPIC0 = NEERU_EVENT_B
    process.env.NEERU_EVENT_C_TOPIC0 = NEERU_EVENT_C
    if (withDepositToken) {
      process.env.NEERU_DEPOSIT_TOKEN_ADDRESS = TOKEN_COPM
    } else {
      delete process.env.NEERU_DEPOSIT_TOKEN_ADDRESS
    }
    _resetParsedEnvForTests()
    _resetEarnRegistryForTests()
  }

  function unsetNeeruEnv(): void {
    delete process.env.NEERU_CONTRACT_ADDRESS
    delete process.env.NEERU_EVENT_A_TOPIC0
    delete process.env.NEERU_EVENT_B_TOPIC0
    delete process.env.NEERU_EVENT_C_TOPIC0
    delete process.env.NEERU_DEPOSIT_TOKEN_ADDRESS
    _resetParsedEnvForTests()
    _resetEarnRegistryForTests()
  }

  function neeruEventLog(opts: {
    logIndex: number
    topic0: string
    user: string
    positionId: bigint
  }): ClassifierLog {
    return {
      logIndex: opts.logIndex,
      contract: NEERU_CONTRACT,
      topic0: opts.topic0,
      topic1: addrTopic(opts.user),
      topic2: '0x' + uintArg(opts.positionId),
      topic3: null,
      data: '0x',
    }
  }

  afterEach(() => {
    unsetNeeruEnv()
  })

  it('kind A (deposit) emits DEPOSIT with appId + positionId + amount from user->contract Transfer', () => {
    setNeeruEnv()
    const tx = baseTx({ from: USER, to: NEERU_CONTRACT })
    const logs: ClassifierLog[] = [
      transferLog({
        logIndex: 0,
        contract: TOKEN_COPM,
        from: USER,
        to: NEERU_CONTRACT,
        value: 100_000_000_000_000_000_000n, // 100 COPm (18 dec)
      }),
      neeruEventLog({ logIndex: 1, topic0: NEERU_EVENT_A, user: USER, positionId: 42n }),
    ]
    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    const earn = out[0] as EarnTransaction
    expect(earn.type).toBe('DEPOSIT')
    expect(earn.appId).toBe('neeru-vaults')
    expect(earn.positionId).toBe('42')
    expect(earn.amount.tokenId).toBe(`celo-mainnet:${TOKEN_COPM}`)
    expect(earn.amount.value).toBe('100.000000000000000000')
    expect(earn.amount.decimals).toBe(18)
    expect(earn.status).toBe('Complete')
  })

  it('kind B (withdraw) emits WITHDRAW with amount from contract->user Transfer', () => {
    setNeeruEnv()
    const tx = baseTx({ from: USER, to: NEERU_CONTRACT })
    const logs: ClassifierLog[] = [
      transferLog({
        logIndex: 0,
        contract: TOKEN_COPM,
        from: NEERU_CONTRACT,
        to: USER,
        value: 50_000_000_000_000_000_000n,
      }),
      neeruEventLog({ logIndex: 1, topic0: NEERU_EVENT_B, user: USER, positionId: 7n }),
    ]
    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    const earn = out[0] as EarnTransaction
    expect(earn.type).toBe('WITHDRAW')
    expect(earn.positionId).toBe('7')
    expect(earn.amount.value).toBe('50.000000000000000000')
  })

  it('kind C (claim) emits CLAIM_REWARD with the incoming Transfer', () => {
    setNeeruEnv()
    const tx = baseTx({ from: USER, to: NEERU_CONTRACT })
    const logs: ClassifierLog[] = [
      transferLog({
        logIndex: 0,
        contract: TOKEN_COPM,
        from: NEERU_CONTRACT,
        to: USER,
        value: 5_000_000_000_000_000_000n,
      }),
      neeruEventLog({ logIndex: 1, topic0: NEERU_EVENT_C, user: USER, positionId: 99n }),
    ]
    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    const earn = out[0] as EarnTransaction
    expect(earn.type).toBe('CLAIM_REWARD')
    expect(earn.positionId).toBe('99')
  })

  it('takes precedence over the swap rule when both patterns would match', () => {
    // Without Earn, this would look like a plain user -> router swap because
    // there's an out-of-user + in-to-user Transfer pair. With the Neeru
    // registry active and the contract emitting event A, it must classify
    // as DEPOSIT instead.
    setNeeruEnv()
    const tx = baseTx({ from: USER, to: NEERU_CONTRACT })
    const logs: ClassifierLog[] = [
      transferLog({
        logIndex: 0,
        contract: TOKEN_COPM,
        from: USER,
        to: NEERU_CONTRACT,
        value: 100_000_000_000_000_000_000n,
      }),
      // some receipt token minted back to the user (simulates an LP token)
      transferLog({
        logIndex: 1,
        contract: TOKEN_USDM,
        from: NEERU_CONTRACT,
        to: USER,
        value: 1n,
      }),
      neeruEventLog({ logIndex: 2, topic0: NEERU_EVENT_A, user: USER, positionId: 1n }),
    ]
    const out = classify(tx, logs, USER)
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('DEPOSIT')
  })

  it('ignores Neeru events emitted for a different user', () => {
    setNeeruEnv()
    const tx = baseTx({ from: USER, to: NEERU_CONTRACT })
    const logs: ClassifierLog[] = [
      transferLog({
        logIndex: 0,
        contract: TOKEN_COPM,
        from: USER,
        to: NEERU_CONTRACT,
        value: 100n,
      }),
      neeruEventLog({
        logIndex: 1,
        topic0: NEERU_EVENT_A,
        user: COUNTERPARTY, // some other user
        positionId: 42n,
      }),
    ]
    const out = classify(tx, logs, USER)
    // No Earn match; falls through to swap / transfer rules. The point of
    // this test is that we do NOT emit DEPOSIT for a Neeru event that was
    // for a different user; whatever the fallback returns is fine.
    expect(out.some((o) => o.type === 'DEPOSIT')).toBe(false)
  })

  it('is a no-op when Neeru env is unset (registry empty)', () => {
    // No setNeeruEnv() call. Registry stays empty.
    _resetEarnRegistryForTests()
    const tx = baseTx({ from: USER, to: NEERU_CONTRACT })
    const logs: ClassifierLog[] = [
      transferLog({
        logIndex: 0,
        contract: TOKEN_COPM,
        from: USER,
        to: NEERU_CONTRACT,
        value: 100n,
      }),
      neeruEventLog({ logIndex: 1, topic0: NEERU_EVENT_A, user: USER, positionId: 1n }),
    ]
    const out = classify(tx, logs, USER)
    expect(out.some((o) => o.type === 'DEPOSIT')).toBe(false)
  })

  it('falls back to any Transfer in the correct direction when no depositToken configured', () => {
    setNeeruEnv({ withDepositToken: false })
    const tx = baseTx({ from: USER, to: NEERU_CONTRACT })
    const logs: ClassifierLog[] = [
      transferLog({
        logIndex: 0,
        contract: TOKEN_USDM,
        from: USER,
        to: NEERU_CONTRACT,
        value: 42n,
      }),
      neeruEventLog({ logIndex: 1, topic0: NEERU_EVENT_A, user: USER, positionId: 1n }),
    ]
    const out = classify(tx, logs, USER)
    const earn = out[0] as EarnTransaction
    expect(earn.type).toBe('DEPOSIT')
    expect(earn.amount.tokenId).toBe(`celo-mainnet:${TOKEN_USDM}`)
  })
})
