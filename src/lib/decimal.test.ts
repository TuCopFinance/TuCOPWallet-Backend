import { decimalString } from './decimal'

describe('decimalString', () => {
  it('formats integer wei with decimals=18', () => {
    expect(decimalString(10n ** 18n, 18)).toBe('1')
  })

  it('formats a fractional value with trailing zeros trimmed', () => {
    expect(decimalString(123_456n, 6)).toBe('0.123456')
  })

  it('handles zero', () => {
    expect(decimalString(0n, 18)).toBe('0')
  })

  it('prefixes negative values with -', () => {
    expect(decimalString(-500n, 3)).toBe('-0.5')
  })

  it('passes through when decimals=0', () => {
    expect(decimalString(42n, 0)).toBe('42')
  })

  it('keeps integer part when fractional is exactly zero (trim does not eat the dot)', () => {
    expect(decimalString(5n * 10n ** 6n, 6)).toBe('5')
  })

  it('handles values smaller than the decimal scale (pads zeros)', () => {
    expect(decimalString(1n, 6)).toBe('0.000001')
  })

  it('handles 6-decimal token (USDT-style) at the boundary', () => {
    // 1 USDT = 1e6 base units
    expect(decimalString(1_000_000n, 6)).toBe('1')
    expect(decimalString(1_500_000n, 6)).toBe('1.5')
    expect(decimalString(999_999n, 6)).toBe('0.999999')
  })
})
