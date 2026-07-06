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

// Canonical Celo mainnet registry. Sourced from Celopedia
// `references/builder-guide.md` (CIP-64 Allowed Fee Currencies) + the Mento
// deployment addresses. Anything outside this set falls back to raw-wei
// emission with a `decimals: null` marker so the wallet knows the value is
// unnormalized (see `decimalizeValueForClassifier` below).
const TOKEN_REGISTRY: Record<string, TokenMeta> = {
  '0x471ece3750da237f93b8e339c536989b8978a438': { symbol: 'CELO', decimals: 18, peggedTo: null },
  '0x765de816845861e75a25fca122bb6898b8b1282a': { symbol: 'USDm', decimals: 18, peggedTo: 'USD' },
  '0x8a567e2ae79ca692bd748ab832081c45de4041ea': { symbol: 'COPm', decimals: 18, peggedTo: 'COP' },
  '0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73': { symbol: 'EURm', decimals: 18, peggedTo: 'EUR' },
  '0xe8537a3d056da446677b9e9d6c5db704eaab4787': { symbol: 'BRLm', decimals: 18, peggedTo: 'BRL' },
  '0xceba9300f2b948710d2653dd7b07f33a8b32118c': { symbol: 'USDC', decimals: 6, peggedTo: 'USD' },
  '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e': { symbol: 'USDT', decimals: 6, peggedTo: 'USD' },
}

// Adapter-only fee currencies (CIP-64). When `tx.feeCurrency` is one of these
// adapter contracts, the classifier surfaces the underlying token on the
// emit (tokenId + decimals) so the wallet renders "you paid X USDC in gas"
// rather than the meaningless adapter address. The value the receipt reports
// is denominated in the adapter's 18-decimal-normalised units - we
// downshift it to the underlying's native decimals by dividing by
// 10^(18 - underlyingDecimals).
interface FeeAdapterMeta {
  symbol: string
  underlyingContract: string
  underlyingDecimals: number
}

const FEE_ADAPTER_REGISTRY: Record<string, FeeAdapterMeta> = {
  '0x2f25deb3848c207fc8e0c34035b3ba7fc157602b': {
    symbol: 'USDC',
    underlyingContract: '0xceba9300f2b948710d2653dd7b07f33a8b32118c',
    underlyingDecimals: 6,
  },
  '0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72': {
    symbol: 'USDT',
    underlyingContract: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
    underlyingDecimals: 6,
  },
}

function contractFromTokenId(tokenId: string): string | null {
  const idx = tokenId.indexOf(':')
  if (idx < 0) return null
  const contract = tokenId.slice(idx + 1).toLowerCase()
  if (!contract.startsWith('0x')) return null
  return contract
}

// Convert wei-style integer string to a fixed-decimal string. No floating
// point. By default trailing zeros are trimmed for human readability
// ("5000000000000000000" with decimals=18 returns "5"). Pass padded:true
// to preserve the full fractional width ("5.000000000000000000") so the
// output matches Valora's `TokenAmount.value` byte-exactly.
export function weiToDecimal(
  weiValue: string,
  decimals: number,
  options: { padded?: boolean } = {},
): string {
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
  const wholeStr = whole.toString()
  if (options.padded) {
    // Always show the full decimals count. Valora emits e.g.
    // "3500.000000000000000000" and byte-exact diffs depend on this.
    const fracPadded = frac.toString().padStart(decimals, '0')
    return (negative ? '-' : '') + `${wholeStr}.${fracPadded}`
  }
  if (frac === 0n) return (negative ? '-' : '') + wholeStr
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  const body = fracStr.length > 0 ? `${wholeStr}.${fracStr}` : wholeStr
  return (negative ? '-' : '') + body
}

// Return the ERC20 decimals for a tokenId (`${networkId}:${contract}`). Null
// when we don't have canonical metadata for the token, which is the signal
// for the classifier / enrichment layer to emit `decimals: null` instead of
// silently mis-decimalising.
export function decimalsForTokenId(tokenId: string): number | null {
  const contract = contractFromTokenId(tokenId)
  if (!contract) return null
  const meta = TOKEN_REGISTRY[contract]
  return meta ? meta.decimals : null
}

// Convert a raw wei bigint into the Valora-compatible padded decimal string
// used on `TokenAmount.value`. Returns the raw stringified value when the
// token is unknown; callers should also set `decimals: null` on the
// TokenAmount so the wallet knows the value is not normalised.
export function decimalizeValueForClassifier(
  rawWei: bigint,
  tokenId: string,
): string {
  const decimals = decimalsForTokenId(tokenId)
  if (decimals === null) return rawWei.toString()
  return weiToDecimal(rawWei.toString(), decimals, { padded: true })
}

// Resolve a CIP-64 fee currency address to the { tokenId, decimals, rawWei }
// triple the classifier emits on `fees[].amount`. Handles three cases:
//
//  1. `feeCurrency == null` -> native CELO fee. Uses the CELO ERC20 contract
//     id and the raw wei from the receipt as-is.
//  2. `feeCurrency` is a Mento native fee token (USDm / COPm / EURm / BRLm)
//     -> use it directly. Value is already in the token's decimals.
//  3. `feeCurrency` is an adapter (USDC / USDT) -> surface the underlying
//     token id + underlying decimals so the wallet renders "you paid X USDC
//     in gas". The receipt reports fee in 18-decimal-normalised adapter
//     units; downshift by dividing by 10^(18 - underlyingDecimals) so the
//     value stays in the underlying's native decimal scale.
export function resolveFeeCurrency(
  feeCurrency: string | null,
  rawFeeWei: bigint,
  networkPrefix: string,
): { tokenId: string; decimals: number; rawWei: bigint } {
  if (!feeCurrency) {
    return {
      tokenId: `${networkPrefix}:0x471ece3750da237f93b8e339c536989b8978a438`,
      decimals: 18,
      rawWei: rawFeeWei,
    }
  }
  const lower = feeCurrency.toLowerCase()
  const adapter = FEE_ADAPTER_REGISTRY[lower]
  if (adapter) {
    const shift = 18n - BigInt(adapter.underlyingDecimals)
    const divisor = 10n ** shift
    const rawInUnderlyingUnits = rawFeeWei / divisor
    return {
      tokenId: `${networkPrefix}:${adapter.underlyingContract}`,
      decimals: adapter.underlyingDecimals,
      rawWei: rawInUnderlyingUnits,
    }
  }
  const meta = TOKEN_REGISTRY[lower]
  return {
    tokenId: `${networkPrefix}:${lower}`,
    decimals: meta ? meta.decimals : 18,
    rawWei: rawFeeWei,
  }
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

// buildLocalAmount takes the RAW wei value produced by the classifier and
// decimalizes internally; but from the enrichment layer the value on the
// TokenAmount is already the decimal string, so we need a variant that
// treats an already-decimalised value. For the pegged 1:1 case we can just
// echo the value.
function buildLocalAmountFromDecimalValue(
  tokenId: string,
  decimalValue: string,
  currencyCode: string,
): LocalAmount | null {
  const contract = contractFromTokenId(tokenId)
  if (!contract) return null
  const meta = TOKEN_REGISTRY[contract]
  if (!meta || meta.peggedTo === null) return null
  const targetCurrency = currencyCode.toUpperCase()
  if (meta.peggedTo !== targetCurrency) return null
  return { value: decimalValue, currencyCode: targetCurrency, exchangeRate: '1' }
}

function enrichAmount(
  amount: TokenAmount,
  currencyCode: string,
  timestamp: number,
): TokenAmount {
  // `localAmount` is always populated - `null` when the token has no peg
  // or the requested currency does not match. Valora emits null in the same
  // situations; matching byte-for-byte cuts diff noise on shape-checks.
  const local = amount.localAmount
    ?? buildLocalAmountFromDecimalValue(amount.tokenId, amount.value, currencyCode)
    ?? null
  return {
    ...amount,
    // Every TokenAmount carries the parent tx timestamp so a downstream
    // consumer that receives just one amount (e.g. a fee row rendered in
    // isolation) still has the temporal context Valora provided.
    timestamp,
    localAmount: local,
  }
}

// Walks every TokenAmount field on a TokenTransaction and populates
// localAmount + nested timestamp. Pure: no I/O.
export function enrichTransactionWithLocalAmount(
  tx: TokenTransaction,
  currencyCode: string,
): TokenTransaction {
  const ts = tx.timestamp
  const fees = tx.fees.map((f) => ({
    ...f,
    amount: enrichAmount(f.amount, currencyCode, ts),
  }))
  if (tx.type === 'SWAP_TRANSACTION') {
    return {
      ...tx,
      fees,
      inAmount: enrichAmount(tx.inAmount, currencyCode, ts),
      outAmount: enrichAmount(tx.outAmount, currencyCode, ts),
      fromTokenAmounts: tx.fromTokenAmounts?.map((a) => enrichAmount(a, currencyCode, ts)),
    }
  }
  if (tx.type === 'SENT' || tx.type === 'RECEIVED') {
    return {
      ...tx,
      fees,
      amount: enrichAmount(tx.amount, currencyCode, ts),
    }
  }
  // APPROVAL: only fees carry amounts.
  return { ...tx, fees }
}
