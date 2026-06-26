import { classify } from './classifier'
import type { ClassifierLog, ClassifierTx, SwapTransaction } from './types'

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
    expect(swap.inAmount.tokenId).toBe(`celo-mainnet:${TOKEN_COPM}`)
    expect(swap.inAmount.value).toBe('999')
    expect(swap.outAmount.tokenId).toBe(`celo-mainnet:${TOKEN_USDT}`) // highest of the 3 sold
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
    const t = out[0] as { type: 'SENT'; amount: { tokenId: string; value: string }; address: string }
    expect(t.amount.value).toBe('500')
    expect(t.amount.tokenId).toBe(`celo-mainnet:${TOKEN_USDM}`)
    expect(t.address).toBe(COUNTERPARTY)
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
    expect(t.amount.value).toBe('5000000000000000000')
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
    expect(t.amount.value).toBe('1234')
  })

  it('reverted transactions are omitted', () => {
    const tx = baseTx({ status: 'reverted', valueWei: 1n })
    expect(classify(tx, [], USER)).toEqual([])
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
