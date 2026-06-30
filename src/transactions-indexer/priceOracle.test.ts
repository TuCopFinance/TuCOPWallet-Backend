import {
  buildLocalAmount,
  enrichTransactionWithLocalAmount,
  weiToDecimal,
} from './priceOracle'
import type { TokenTransaction } from './types'

const COPM = 'celo-mainnet:0x8a567e2ae79ca692bd748ab832081c45de4041ea'
const USDM = 'celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a'
const USDC = 'celo-mainnet:0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const CELO = 'celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438'
const UNKNOWN = 'celo-mainnet:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

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
  function baseTx(): Omit<TokenTransaction, 'type' | 'amount' | 'inAmount' | 'outAmount' | 'approvedAddress' | 'tokenId' | 'fromTokenAmounts'> {
    return {
      networkId: 'celo-mainnet',
      transactionHash: '0xabc',
      timestamp: 1_700_000_000_000,
      block: '100',
      address: '0x1111111111111111111111111111111111111111',
      fees: [],
    }
  }

  it('enriches SENT with matching peg', () => {
    const tx = {
      ...baseTx(),
      type: 'SENT' as const,
      amount: { tokenId: COPM, value: '1000000000000000000' },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    if (enriched.type !== 'SENT') throw new Error('type narrowing')
    expect(enriched.amount.localAmount).toEqual({
      value: '1',
      currencyCode: 'COP',
      exchangeRate: '1',
    })
  })

  it('leaves amount without localAmount when peg mismatches', () => {
    const tx = {
      ...baseTx(),
      type: 'RECEIVED' as const,
      amount: { tokenId: COPM, value: '1000000000000000000' },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'USD')
    if (enriched.type !== 'RECEIVED') throw new Error('type narrowing')
    expect(enriched.amount.localAmount).toBeUndefined()
  })

  it('enriches SWAP_TRANSACTION inAmount + outAmount independently', () => {
    const tx = {
      ...baseTx(),
      type: 'SWAP_TRANSACTION' as const,
      inAmount: { tokenId: COPM, value: '10292000000000000000000' },
      outAmount: { tokenId: USDM, value: '1010000000000000000' },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    if (enriched.type !== 'SWAP_TRANSACTION') throw new Error('type narrowing')
    expect(enriched.inAmount.localAmount?.value).toBe('10292')
    expect(enriched.outAmount.localAmount).toBeUndefined()
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
          amount: { tokenId: COPM, value: '500000000000000' },
        },
      ],
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    expect(enriched.fees[0]?.amount.localAmount).toEqual({
      value: '0.0005',
      currencyCode: 'COP',
      exchangeRate: '1',
    })
  })

  it('does not overwrite a pre-existing localAmount', () => {
    const preset = { value: '999', currencyCode: 'COP', exchangeRate: '1' }
    const tx = {
      ...baseTx(),
      type: 'SENT' as const,
      amount: { tokenId: COPM, value: '1000000000000000000', localAmount: preset },
    }
    const enriched = enrichTransactionWithLocalAmount(tx, 'COP')
    if (enriched.type !== 'SENT') throw new Error('type narrowing')
    expect(enriched.amount.localAmount).toEqual(preset)
  })
})
