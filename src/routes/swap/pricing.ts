// Numeric helpers for the swap route: bigint-based fixed-point math to
// keep precision on token amounts above 2^53 wei (Number would lose
// precision above ~9 USDT for a 18-dec token). Extracted from swap.ts
// because these helpers are pure + reusable across the Squid path,
// the Uniswap V4 path, and any future aggregator adapter.

export const PRICE_SCALE = 1_000_000_000_000_000_000n // 1e18

export function safeBigInt(value: string | undefined): bigint | null {
  if (!value) return null
  try {
    const v = BigInt(value)
    return v >= 0n ? v : null
  } catch {
    return null
  }
}

// Parse a decimal string like "0.9945" or "3242.712" into a bigint scaled
// by PRICE_SCALE (1e18). Returns null on any parse error. Truncates
// fractional beyond 18 digits (matches PRICE_SCALE precision).
export function parseDecimalToScaled(value: string): bigint | null {
  if (!value) return null
  const negative = value.startsWith('-')
  const cleaned = negative ? value.slice(1) : value
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null
  const parts = cleaned.split('.')
  const wholePart = parts[0] ?? '0'
  const fracPart = parts[1] ?? ''
  const fracPadded = fracPart.padEnd(18, '0').slice(0, 18)
  try {
    const scaled = BigInt(wholePart) * PRICE_SCALE + BigInt(fracPadded || '0')
    return negative ? -scaled : scaled
  } catch {
    return null
  }
}

// Compute `guaranteedPrice` (worst-case exchange rate after slippage) as a
// human-readable decimal string matching the shape of the `price` field.
// Both `toAmountMin` and `toAmount` are wei of the SAME token (the buy
// token), so `toAmountMin / toAmount` is a pure decimal ratio independent
// of either token's decimals. Multiplying that ratio by the already-
// normalized `price` (whole/whole from Squid's `est.exchangeRate`) yields
// the normalized `guaranteedPrice` without needing per-token decimals
// lookup. Callsite passes buy-side wei for both amounts.
//
// Invariant: computing `toAmountMin / fromAmount` (buy-wei / sell-wei)
// directly is UNSAFE because it produces a wei/wei ratio inflated by
// 10^(sellDecimals - buyDecimals) any time the two tokens have different
// decimals. The wallet sizes `approve()` off this field on buy-mode
// swaps, so the wrong value asks for a colossal allowance.
export function computeGuaranteedPrice(
  toAmountMin: string | undefined,
  toAmount: string,
  price: string,
): string {
  const min = safeBigInt(toAmountMin)
  const total = safeBigInt(toAmount)
  const priceScaled = parseDecimalToScaled(price)
  if (min === null || total === null || total === 0n || priceScaled === null) {
    return price
  }
  const scaled = (priceScaled * min) / total
  const whole = scaled / PRICE_SCALE
  const frac = (scaled % PRICE_SCALE).toString().padStart(18, '0').replace(/0+$/, '')
  return frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`
}

// Compute the whole-unit exchange rate between two token wei amounts,
// normalizing by each token's decimals. Used by the Uniswap V4 path
// where quoter results come back in wei and the wire contract requires
// human-readable ratios (see PR #177 which fixed the initial wei/wei bug).
//
// Scales by 1e18 for output precision, keeps bigint throughout to avoid
// Number precision loss above 2^53.
//
// Wire contract: the returned string is a decimal representation of the
// exchange rate in whole units. E.g. for 1 USDT (6 decimals) -> 3242 COPm
// (18 decimals), returns "3242.xxx", NOT "3.24e15" (wei/wei ratio).
export function computeExchangeRate(
  buyAmountWei: bigint,
  buyDecimals: number,
  sellAmountWei: bigint,
  sellDecimals: number,
): string {
  if (sellAmountWei === 0n) return '0'
  const numer = buyAmountWei * 10n ** BigInt(sellDecimals) * PRICE_SCALE
  const denom = sellAmountWei * 10n ** BigInt(buyDecimals)
  const scaled = numer / denom
  const whole = scaled / PRICE_SCALE
  const frac = (scaled % PRICE_SCALE).toString().padStart(18, '0').replace(/0+$/, '')
  return frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`
}
