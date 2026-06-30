// Format a bigint wei-amount as a decimal-string with the given precision.
// Closes Fase 4 PR 28 (partial - decimal dedup).
//
// Previously this function was duplicated identically in
// src/hooks-api/neeru/detail.ts and src/hooks-api/neeru/positions.ts. Any
// formatting bug fixed in one would silently diverge in the other. One
// home now.
//
// Examples:
//   decimalString(123_456n, 6)     -> '0.123456'
//   decimalString(10n ** 18n, 18)  -> '1'
//   decimalString(-500n, 3)        -> '-0.5'
//   decimalString(0n, 18)          -> '0'
//   decimalString(42n, 0)          -> '42'
//
// Trailing zeros in the fractional part are trimmed. The integer part is
// always emitted (even if zero). Negative bigints prefix the result with '-'.
export function decimalString(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()
  const negative = value < 0n
  const abs = negative ? -value : value
  const asStr = abs.toString().padStart(decimals + 1, '0')
  const whole = asStr.slice(0, asStr.length - decimals)
  const frac = asStr.slice(asStr.length - decimals).replace(/0+$/, '')
  const out = frac.length === 0 ? whole : `${whole}.${frac}`
  return negative ? `-${out}` : out
}
