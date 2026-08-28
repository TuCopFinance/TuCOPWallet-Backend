import { clusterMultiDollarSwaps, _testExports } from './multiSwapClustering'
import type {
  ApprovalTransaction,
  SwapTransaction,
  TokenTransaction,
  TransferTransaction,
} from './types'

const SQUID_ROUTER = '0xce16f69375520ab01377ce7b88f5ba8c48f8d666'

const USDM = 'celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a'
const USDC = 'celo-mainnet:0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const USDT = 'celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const COPM = 'celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea'
const CELO = 'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438'

// Deterministic tx-hash generator so failure messages point at fixtures
// unambiguously.
function hash(seq: number): string {
  return `0x${seq.toString(16).padStart(64, '0')}`
}

interface SwapArgs {
  seq: number
  sellToken: string
  sellValue: string
  buyToken: string
  buyValue: string
  timestampSec: number
  feeToken?: string
  feeValue?: string
  fromTokenAmounts?: SwapTransaction['fromTokenAmounts']
}

function makeSwap(args: SwapArgs): SwapTransaction {
  const {
    seq,
    sellToken,
    sellValue,
    buyToken,
    buyValue,
    timestampSec,
    feeToken = CELO,
    feeValue = '0.001',
    fromTokenAmounts,
  } = args
  return {
    type: 'SWAP_TRANSACTION',
    networkId: 'celo-mainnet',
    transactionHash: hash(seq),
    timestamp: timestampSec * 1000,
    block: String(1000 + seq),
    address: '0x81dcf9160237d0ef0d4db27cfb2ea9743547f882',
    status: 'Complete',
    fees: [
      {
        type: 'SECURITY_FEE',
        amount: { tokenId: feeToken, value: feeValue, decimals: 18 },
      },
    ],
    inAmount: { tokenId: buyToken, value: buyValue, decimals: 18 },
    outAmount: {
      tokenId: sellToken,
      value: sellValue,
      decimals: sellToken === USDM ? 18 : 6,
    },
    fromTokenAmounts,
  }
}

function makeApproval(args: {
  seq: number
  tokenId: string
  timestampSec: number
  approvedAddress?: string
}): ApprovalTransaction {
  return {
    type: 'APPROVAL',
    networkId: 'celo-mainnet',
    transactionHash: hash(args.seq),
    timestamp: args.timestampSec * 1000,
    block: String(3000 + args.seq),
    address: '0x81dcf9160237d0ef0d4db27cfb2ea9743547f882',
    status: 'Complete',
    fees: [],
    tokenId: args.tokenId,
    approvedAddress: args.approvedAddress ?? SQUID_ROUTER,
  }
}

function makeTransfer(args: { seq: number; timestampSec: number }): TransferTransaction {
  return {
    type: 'RECEIVED',
    networkId: 'celo-mainnet',
    transactionHash: hash(args.seq),
    timestamp: args.timestampSec * 1000,
    block: String(2000 + args.seq),
    address: '0x81dcf9160237d0ef0d4db27cfb2ea9743547f882',
    status: 'Complete',
    fees: [],
    amount: { tokenId: COPM, value: '100', decimals: 18 },
  }
}

describe('clusterMultiDollarSwaps', () => {
  it('collapses 3 sequential dollar-family -> COPm swaps within 120s', () => {
    // Feed order: DESC (newest first). Wallet spec: "hash de la LAST tx
    // del cluster" - "last" in time = newest = cluster head (index 0).
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 3, sellToken: USDT, sellValue: '1.79', buyToken: COPM, buyValue: '5559.5', timestampSec: 200 }),
      makeSwap({ seq: 2, sellToken: USDC, sellValue: '1.10', buyToken: COPM, buyValue: '3417.2', timestampSec: 195 }),
      makeSwap({ seq: 1, sellToken: USDM, sellValue: '1.10', buyToken: COPM, buyValue: '3417.2', timestampSec: 190 }),
    ]

    const out = clusterMultiDollarSwaps(desc)

    expect(out).toHaveLength(1)
    const agg = out[0] as SwapTransaction
    expect(agg.type).toBe('SWAP_TRANSACTION')
    // Aggregate uses head (newest) tx metadata.
    expect(agg.transactionHash).toBe(hash(3))
    expect(agg.timestamp).toBe(200_000)
    expect(agg.block).toBe('1003')
    // inAmount summed across all 3 legs.
    expect(agg.inAmount.tokenId).toBe(COPM)
    expect(agg.inAmount.value).toBe('12393.9')
    // outAmount collapsed to USDm placeholder + summed value.
    expect(agg.outAmount.tokenId).toBe(_testExports.AGGREGATE_OUT_TOKEN_ID)
    expect(agg.outAmount.value).toBe('3.99')
    // fromTokenAmounts preserves per-leg breakdown with transactionHash.
    expect(agg.fromTokenAmounts).toEqual([
      { tokenId: USDT, value: '1.79', decimals: 6, transactionHash: hash(3) },
      { tokenId: USDC, value: '1.10', decimals: 6, transactionHash: hash(2) },
      { tokenId: USDM, value: '1.10', decimals: 18, transactionHash: hash(1) },
    ])
    // Fees summed into one entry (same fee token).
    expect(agg.fees).toEqual([
      { type: 'SECURITY_FEE', amount: { tokenId: CELO, value: '0.003', decimals: 18 } },
    ])
  })

  it('keeps a single dollar-family swap as-is (no clustering below MIN_SIZE)', () => {
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 10, sellToken: USDT, sellValue: '5', buyToken: COPM, buyValue: '15500', timestampSec: 500 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    expect(out).toHaveLength(1)
    expect(out[0]?.transactionHash).toBe(hash(10))
    // Not clustered: outAmount stays USDT, no fromTokenAmounts injection.
    expect((out[0] as SwapTransaction).outAmount.tokenId).toBe(USDT)
    expect((out[0] as SwapTransaction).fromTokenAmounts).toBeUndefined()
  })

  it('splits a 4-leg swap into cluster(3) + single when the 4th falls outside the 120s window', () => {
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 4, sellToken: USDT, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 400 }),
      makeSwap({ seq: 3, sellToken: USDC, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 395 }),
      makeSwap({ seq: 2, sellToken: USDM, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 390 }),
      // 275s older than head (400 - 125 = 275). Outside the 120s window.
      makeSwap({ seq: 1, sellToken: USDM, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 275 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    expect(out).toHaveLength(2)
    // Cluster of 3 (seq 4, 3, 2)
    const agg = out[0] as SwapTransaction
    expect(agg.transactionHash).toBe(hash(4))
    expect(agg.fromTokenAmounts).toHaveLength(3)
    expect(agg.fromTokenAmounts?.map((a) => a.transactionHash)).toEqual([hash(4), hash(3), hash(2)])
    // Single remainder (seq 1)
    expect(out[1]?.transactionHash).toBe(hash(1))
    expect((out[1] as SwapTransaction).fromTokenAmounts).toBeUndefined()
  })

  it('does NOT cluster across different buy tokens', () => {
    // Two swaps, both dollar-family sold, within window, but the buy
    // tokens differ. Must stay separate; the wallet displays each row
    // with its own buy-token detail.
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 2, sellToken: USDT, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 200 }),
      makeSwap({ seq: 1, sellToken: USDC, sellValue: '1', buyToken: CELO, buyValue: '13', timestampSec: 195 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    expect(out).toHaveLength(2)
    expect(out[0]?.transactionHash).toBe(hash(2))
    expect(out[1]?.transactionHash).toBe(hash(1))
  })

  it('absorbs Squid `approve(SquidRouter, ...)` interleaved between swap legs (real prod pattern)', () => {
    // Reproduces the exact tx sequence observed on prod deploy #241
    // (spike v2 wallet, blocks 75991249..75991267): three swaps
    // interleaved with two USDT+USDC approvals to Squid Router.
    // Before the fix, adjacency was broken by the approvals and the
    // cluster only got size=1 per swap. After the fix, the swaps
    // collapse into one aggregate and the approvals re-emit after.
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 10, sellToken: USDT, sellValue: '1.79', buyToken: COPM, buyValue: '5605', timestampSec: 2025 }),
      makeApproval({ seq: 9, tokenId: USDT, timestampSec: 2024 }),
      makeSwap({ seq: 8, sellToken: USDC, sellValue: '1.10', buyToken: COPM, buyValue: '3443', timestampSec: 2018 }),
      makeApproval({ seq: 7, tokenId: USDC, timestampSec: 2016 }),
      makeSwap({ seq: 6, sellToken: USDM, sellValue: '1.10', buyToken: COPM, buyValue: '3444', timestampSec: 2007 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    // 1 aggregate + 2 approvals = 3 rows total.
    expect(out).toHaveLength(3)
    const agg = out[0] as SwapTransaction
    expect(agg.type).toBe('SWAP_TRANSACTION')
    expect(agg.transactionHash).toBe(hash(10))
    expect(agg.fromTokenAmounts).toHaveLength(3)
    expect(agg.fromTokenAmounts?.map((a) => a.tokenId)).toEqual([USDT, USDC, USDM])
    expect(agg.fromTokenAmounts?.map((a) => a.transactionHash)).toEqual([
      hash(10),
      hash(8),
      hash(6),
    ])
    // Approvals re-emit after the aggregate in DESC order (matches
    // their position in the input feed).
    expect(out[1]?.type).toBe('APPROVAL')
    expect(out[1]?.transactionHash).toBe(hash(9))
    expect(out[2]?.type).toBe('APPROVAL')
    expect(out[2]?.transactionHash).toBe(hash(7))
  })

  it('does NOT absorb approvals to a non-Squid address (breaks cluster like any other unrelated tx)', () => {
    // An approval to, say, a Neeru contract does not belong to the
    // Squid multi-swap flow and must break the cluster.
    const NEERU_ADDR = '0x988af5977201a0e988f2c75ea952532f6beb5082'
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 3, sellToken: USDT, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 200 }),
      makeApproval({ seq: 2, tokenId: USDT, timestampSec: 198, approvedAddress: NEERU_ADDR }),
      makeSwap({ seq: 1, sellToken: USDC, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 195 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    // 3 singletons - the Neeru approval broke the run.
    expect(out).toHaveLength(3)
    expect((out[0] as SwapTransaction).fromTokenAmounts).toBeUndefined()
    expect(out[1]?.type).toBe('APPROVAL')
    expect((out[2] as SwapTransaction).fromTokenAmounts).toBeUndefined()
  })

  it('interrupts a cluster when a non-swap tx breaks the adjacent run (per-page order)', () => {
    // Feed row 3 is a RECEIVED transfer breaking the adjacency between
    // two swap legs. Do NOT merge across the gap - conservative
    // behavior; wallet spec is "N adjacent swaps".
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 3, sellToken: USDT, sellValue: '2', buyToken: COPM, buyValue: '6200', timestampSec: 300 }),
      makeTransfer({ seq: 99, timestampSec: 298 }),
      makeSwap({ seq: 1, sellToken: USDM, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 290 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    expect(out).toHaveLength(3)
    // Each survives as its own event (both singletons since the gap
    // isolated them).
    expect(out[0]?.transactionHash).toBe(hash(3))
    expect(out[1]?.transactionHash).toBe(hash(99))
    expect(out[2]?.transactionHash).toBe(hash(1))
  })

  it('does NOT touch an atomic 7702 swap that already carries fromTokenAmounts', () => {
    const atomic = makeSwap({
      seq: 5,
      sellToken: USDT,
      sellValue: '4',
      buyToken: COPM,
      buyValue: '12400',
      timestampSec: 500,
      fromTokenAmounts: [
        { tokenId: USDT, value: '1.5', decimals: 6 },
        { tokenId: USDM, value: '2.5', decimals: 18 },
      ],
    })
    const legacy = makeSwap({
      seq: 4,
      sellToken: USDM,
      sellValue: '1',
      buyToken: COPM,
      buyValue: '3100',
      timestampSec: 495,
    })
    const out = clusterMultiDollarSwaps([atomic, legacy])
    // Atomic passes through untouched; legacy stays as a singleton.
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(atomic)
    expect((out[1] as SwapTransaction).transactionHash).toBe(hash(4))
    expect((out[1] as SwapTransaction).fromTokenAmounts).toBeUndefined()
  })

  it('skips clustering when the sold token is NOT in the dollar-family set', () => {
    // Swap sold XAUt (gold) and COPm (peso) into CELO - neither is
    // dollar-family. No cluster.
    const XAUt = 'celo-mainnet:0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff'
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 2, sellToken: XAUt, sellValue: '0.001', buyToken: CELO, buyValue: '10', timestampSec: 200 }),
      makeSwap({ seq: 1, sellToken: COPM, sellValue: '5000', buyToken: CELO, buyValue: '1', timestampSec: 195 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    expect(out).toHaveLength(2)
    expect((out[0] as SwapTransaction).fromTokenAmounts).toBeUndefined()
    expect((out[1] as SwapTransaction).fromTokenAmounts).toBeUndefined()
  })

  it('boundary: two legs EXACTLY 120s apart cluster (inclusive window)', () => {
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 2, sellToken: USDT, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 320 }),
      makeSwap({ seq: 1, sellToken: USDC, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 200 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    expect(out).toHaveLength(1)
    expect((out[0] as SwapTransaction).fromTokenAmounts).toHaveLength(2)
  })

  it('boundary: two legs 121s apart do NOT cluster', () => {
    const desc: TokenTransaction[] = [
      makeSwap({ seq: 2, sellToken: USDT, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 321 }),
      makeSwap({ seq: 1, sellToken: USDC, sellValue: '1', buyToken: COPM, buyValue: '3100', timestampSec: 200 }),
    ]
    const out = clusterMultiDollarSwaps(desc)
    expect(out).toHaveLength(2)
  })

  it('empty input returns empty output', () => {
    expect(clusterMultiDollarSwaps([])).toEqual([])
  })
})

describe('sumDecimalStrings', () => {
  const { sumDecimalStrings } = _testExports

  it('sums same-precision values', () => {
    expect(sumDecimalStrings(['1.10', '1.10', '1.79'])).toBe('3.99')
  })

  it('handles mixed precision (USDT 6-dec + USDm 18-dec input strings)', () => {
    expect(sumDecimalStrings(['1.100000', '1.100000000000000000'])).toBe('2.200000000000000000')
  })

  it('sums integers with no fractional part', () => {
    expect(sumDecimalStrings(['100', '200', '50'])).toBe('350')
  })

  it('handles a single value passthrough', () => {
    expect(sumDecimalStrings(['3.14'])).toBe('3.14')
  })

  it('zero-pads correctly when sum is less than 1', () => {
    expect(sumDecimalStrings(['0.5', '0.3'])).toBe('0.8')
    // Carry across the decimal boundary
    expect(sumDecimalStrings(['0.5', '0.7'])).toBe('1.2')
  })
})
