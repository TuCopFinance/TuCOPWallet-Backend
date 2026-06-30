import type { LocalAmount, TokenAmount, TokenTransaction } from './types'

// MVP price oracle for the transaction feed.
//
// Scope: only convert when the token has a hard fiat peg (Mento stables and
// stablecoins) AND the requested local currency matches that peg. Anything
// else returns null and the wallet keeps its own price logic for display.
//
// This intentionally skips:
// - CELO -> any fiat (volatile, needs CoinMarketCap historical).
// - Cross-currency conversion (USDm -> COP, COPm -> USD): needs an FX feed.
// - Cross-time correctness (uses spot peg, not the historical price at the
//   tx's block timestamp). The peg is stable enough for MVP feed display.
//
// Adding CMC + FX is a follow-up tracked in `tasks/plans/wri-transaction-feed-indexer.md`.

interface TokenMeta {
  symbol: string
  decimals: number
  // ISO 4217 currency the token is pegged to. null means volatile (skip).
  peggedTo: string | null
}

const TOKEN_REGISTRY: Record<string, TokenMeta> = {
  '0x471ece3750da237f93b8e339c536989b8978a438': { symbol: 'CELO', decimals: 18, peggedTo: null },
  '0x765de816845861e75a25fca122bb6898b8b1282a': { symbol: 'USDm', decimals: 18, peggedTo: 'USD' },
  '0x8a567e2ae79ca692bd748ab832081c45de4041ea': { symbol: 'COPm', decimals: 18, peggedTo: 'COP' },
  '0xceba9300f2b948710d2653dd7b07f33a8b32118c': { symbol: 'USDC', decimals: 6, peggedTo: 'USD' },
  '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e': { symbol: 'USDT', decimals: 6, peggedTo: 'USD' },
}

function contractFromTokenId(tokenId: string): string | null {
  const idx = tokenId.indexOf(':')
  if (idx < 0) return null
  const contract = tokenId.slice(idx + 1).toLowerCase()
  if (!contract.startsWith('0x')) return null
  return contract
}

// Convert wei-style integer string to a fixed-decimal string. No floating
// point. Trailing zeros are trimmed but the integer part is preserved (so
// "5000000000000000000" with decimals=18 returns "5", and
// "1234567890000000000" with decimals=18 returns "1.23456789").
export function weiToDecimal(weiValue: string, decimals: number): string {
  if (decimals === 0) return weiValue
  let wei: bigint
  try {
    wei = BigInt(weiValue)
  } catch {
    return weiValue
  }
  const negative = wei < 0n
  if (negative) wei = -wei
  const divisor = 10n ** BigInt(decimals)
  const whole = wei / divisor
  const frac = wei % divisor
  if (frac === 0n) return (negative ? '-' : '') + whole.toString()
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString()
  return (negative ? '-' : '') + body
}

export function buildLocalAmount(
  tokenId: string,
  weiValue: string,
  currencyCode: string,
): LocalAmount | null {
  const contract = contractFromTokenId(tokenId)
  if (!contract) return null
  const meta = TOKEN_REGISTRY[contract]
  if (!meta || meta.peggedTo === null) return null
  const targetCurrency = currencyCode.toUpperCase()
  if (meta.peggedTo !== targetCurrency) return null
  const value = weiToDecimal(weiValue, meta.decimals)
  return { value, currencyCode: targetCurrency, exchangeRate: '1' }
}

function enrichAmount(amount: TokenAmount, currencyCode: string): TokenAmount {
  if (amount.localAmount) return amount
  const localAmount = buildLocalAmount(amount.tokenId, amount.value, currencyCode)
  return localAmount ? { ...amount, localAmount } : amount
}

// Walks every TokenAmount field on a TokenTransaction and populates
// localAmount where the token's peg matches currencyCode. Pure: no I/O.
export function enrichTransactionWithLocalAmount(
  tx: TokenTransaction,
  currencyCode: string,
): TokenTransaction {
  const fees = tx.fees.map((f) => ({
    ...f,
    amount: enrichAmount(f.amount, currencyCode),
  }))
  if (tx.type === 'SWAP_TRANSACTION') {
    return {
      ...tx,
      fees,
      inAmount: enrichAmount(tx.inAmount, currencyCode),
      outAmount: enrichAmount(tx.outAmount, currencyCode),
      fromTokenAmounts: tx.fromTokenAmounts?.map((a) => enrichAmount(a, currencyCode)),
    }
  }
  if (tx.type === 'SENT' || tx.type === 'RECEIVED') {
    return {
      ...tx,
      fees,
      amount: enrichAmount(tx.amount, currencyCode),
    }
  }
  // APPROVAL: only fees carry amounts.
  return { ...tx, fees }
}
