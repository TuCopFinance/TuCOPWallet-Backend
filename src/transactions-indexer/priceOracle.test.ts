import {
  buildLocalAmount,
  decimalizeValueForClassifier,
  decimalsForTokenId,
  enrichTransactionWithLocalAmount,
  weiToDecimal,
} from './priceOracle'
import type { TokenTransaction } from './types'

const COPM = 'celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea'
const USDM = 'celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a'
const USDC = 'celo-mainnet:0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const CELO = 'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438'
const UNKNOWN = 'celo-mainnet:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

describe('weiToDecimal padded option', () => {
  it('always emits full decimals width when padded=true', () => {
    expect(weiToDecimal('5000000000000000000', 18, { padded: true })).toBe(
      '5.000000000000000000',
    )
  })
  it('preserves precision on non-round values when padded=true', () => {
    expect(weiToDecimal('1234567890000000000', 18, { padded: true })).toBe(
      '1.234567890000000000',
    )
  })
  it('padded works for 6-decimal tokens (USDC/USDT)', () => {
    expect(weiToDecimal('1500000', 6, { padded: true })).toBe('1.500000')
  })
  it('padded handles zero', () => {
    expect(weiToDecimal('0', 18, { padded: true })).toBe('0.000000000000000000')
  })
})

describe('decimalsForTokenId', () => {
  it('returns 18 for CELO / Mento stables', () => {
    expect(decimalsForTokenId(COPM)).toBe(18)
    expect(decimalsForTokenId(USDM)).toBe(18)
    expect(decimalsForTokenId(CELO)).toBe(18)
  })
  it('returns 6 for USDC / USDT', () => {
    expect(decimalsForTokenId(USDC)).toBe(6)
    expect(
      decimalsForTokenId('celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'),
    ).toBe(6)
  })
  it('returns null for unknown tokens', () => {
    expect(decimalsForTokenId(UNKNOWN)).toBeNull()
  })
})

describe('decimalizeValueForClassifier', () => {
  // Direct fixture for Bug 1 root cause: pre-fix the classifier emitted
  // `3548058099761767921454` (raw wei) which the wallet consumer rendered
  // as-is. Post-fix, the value is the Valora-shape decimal string.
  it('COPm 3548.058099761767921454 emits padded 18-decimal string', () => {
    expect(decimalizeValueForClassifier(3548058099761767921454n, COPM)).toBe(
      '3548.058099761767921454',
    )
  })
  it('USDC 1.5 emits padded 6-decimal string', () => {
    expect(decimalizeValueForClassifier(1_500_000n, USDC)).toBe('1.500000')
  })
  it('unknown token falls back to raw wei so no precision is silently lost', () => {
    expect(decimalizeValueForClassifier(1_500_000n, UNKNOWN)).toBe('1500000')
  })
})

describe('weiToDecimal', () => {
  it('handles whole numbers', () => {
    expect(weiToDecimal('5000000000000000000', 18)).toBe('5')
  })

  it('trims trailing zeros from fractional part', () => {
    expect(weiToDecimal('1234567890000000000', 18)).toBe('1.23456789')
  })

  it('handles values smaller than one (leading zeros preserved)', () => {
    expect(weiToDecimal('1', 18)).toBe('0.000000000000000001')
  })

  it('handles decimals=6 for USDC/USDT', () => {
    expect(weiToDecimal('1500000', 6)).toBe('1.5')
  })

  it('handles decimals=0 as identity', () => {
    expect(weiToDecimal('42', 0)).toBe('42')
  })

  it('handles zero', () => {
    expect(weiToDecimal('0', 18)).toBe('0')
  })

  it('returns the raw value on parse error rather than throwing', () => {
    expect(weiToDecimal('not-a-number', 18)).toBe('not-a-number')
  })

  it('handles negative values', () => {
    expect(weiToDecimal('-1000000000000000000', 18)).toBe('-1')
  })
})

describe('buildLocalAmount', () => {
  it('returns 1:1 conversion when token peg matches currency', () => {
    expect(buildLocalAmount(COPM, '10292000000000000000000', 'COP')).toEqual({
      value: '10292',
      currencyCode: 'COP',
      exchangeRate: '1',
    })
  })

  it('uppercases the requested currency', () => {
    expect(buildLocalAmount(USDM, '1000000000000000000', 'usd')).toEqual({
      value: '1',
      currencyCode: 'USD',
      exchangeRate: '1',
    })
  })

  it('returns null when peg does not match (USDm requesting COP)', () => {
    expect(buildLocalAmount(USDM, '1000000000000000000', 'COP')).toBeNull()
  })

  it('returns null for volatile tokens (CELO)', () => {
    expect(buildLocalAmount(CELO, '1000000000000000000', 'USD')).toBeNull()
  })

  it('returns null for unknown tokens', () => {
    expect(buildLocalAmount(UNKNOWN, '1', 'USD')).toBeNull()
  })

  it('handles USDC (6 decimals)', () => {
    expect(buildLocalAmount(USDC, '1500000', 'USD')).toEqual({
      value: '1.5',
      currencyCode: 'USD',
      exchangeRate: '1',
    })
  })

  it('returns null for malformed tokenId', () => {
    expect(buildLocalAmount('not-a-token-id', '1', 'USD')).toBeNull()
  })
})

describe('enrichTransactionWithLocalAmount', () => {
  // Post-2026-07-05: input `value` is already the decimal string emitted by
  // the classifier (via `decimalizeValueForClassifier`), NOT raw wei. The
  // enrichment layer just echoes it into localAmount when peg matches.
  function baseTx(): Omit<
    TokenTransaction,
    'type' | 'amount' | 'inAmount' | 'outAmount' | 'approvedAddress' | 'tokenId' | 'fromTokenAmounts'
  > {
    return {
      networkId: 'celo-mainnet',
      transactionHash: '0xabc',
      timestamp: 1_700_000_000_000,
      block: '100',
      address: '0x1111111111111111111111111111111111111111',
      status: 'Complete',
      fees: [],
    }
  }

  it('enriches SENT with matching peg + adds timestamp + populates localAmount', () => {
    const tx = {
      ...baseTx(),
      type: 'SENT' as const,
      amount: { tokenId: COPM, value: '1.000000000000000000', decimals: 18 },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    if (enriched.type !== 'SENT') throw new Error('type narrowing')
    expect(enriched.amount.localAmount).toEqual({
      value: '1.000000000000000000',
      currencyCode: 'COP',
      exchangeRate: '1',
    })
    expect(enriched.amount.timestamp).toBe(1_700_000_000_000)
  })

  it('emits localAmount:null explicitly when peg mismatches', () => {
    const tx = {
      ...baseTx(),
      type: 'RECEIVED' as const,
      amount: { tokenId: COPM, value: '1.000000000000000000', decimals: 18 },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'USD')
    if (enriched.type !== 'RECEIVED') throw new Error('type narrowing')
    expect(enriched.amount).toHaveProperty('localAmount')
    expect(enriched.amount.localAmount).toBeNull()
  })

  it('enriches SWAP_TRANSACTION inAmount + outAmount independently', () => {
    const tx = {
      ...baseTx(),
      type: 'SWAP_TRANSACTION' as const,
      inAmount: {
        tokenId: COPM,
        value: '10292.000000000000000000',
        decimals: 18,
      },
      outAmount: {
        tokenId: USDM,
        value: '1.010000000000000000',
        decimals: 18,
      },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    if (enriched.type !== 'SWAP_TRANSACTION') throw new Error('type narrowing')
    expect(enriched.inAmount.localAmount?.value).toBe('10292.000000000000000000')
    expect(enriched.outAmount.localAmount).toBeNull()
  })

  it('enriches APPROVAL fees only (no amount field)', () => {
    const tx = {
      ...baseTx(),
      type: 'APPROVAL' as const,
      tokenId: COPM,
      approvedAddress: '0x2222222222222222222222222222222222222222',
      fees: [
        {
          type: 'SECURITY_FEE' as const,
          amount: { tokenId: COPM, value: '0.000500000000000000', decimals: 18 },
        },
      ],
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    expect(enriched.fees[0]?.amount.localAmount).toEqual({
      value: '0.000500000000000000',
      currencyCode: 'COP',
      exchangeRate: '1',
    })
    expect(enriched.fees[0]?.amount.timestamp).toBe(1_700_000_000_000)
  })

  it('does not overwrite a pre-existing localAmount', () => {
    const preset = { value: '999', currencyCode: 'COP', exchangeRate: '1' }
    const tx = {
      ...baseTx(),
      type: 'SENT' as const,
      amount: {
        tokenId: COPM,
        value: '1.000000000000000000',
        decimals: 18,
        localAmount: preset,
      },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    if (enriched.type !== 'SENT') throw new Error('type narrowing')
    expect(enriched.amount.localAmount).toEqual(preset)
  })
})
