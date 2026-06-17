import { stripReservedParams, buildSafeQueryString, buildCacheKey } from './query'

describe('stripReservedParams', () => {
  it('removes apikey and api_key (case-insensitive)', () => {
    expect(stripReservedParams({ apikey: 'evil', foo: 'bar' })).toEqual({ foo: 'bar' })
    expect(stripReservedParams({ APIKEY: 'evil', foo: 'bar' })).toEqual({ foo: 'bar' })
    expect(stripReservedParams({ api_key: 'evil', foo: 'bar' })).toEqual({ foo: 'bar' })
  })

  it('passes through normal params', () => {
    expect(stripReservedParams({ filter: 'to', block_number: '123' })).toEqual({
      filter: 'to',
      block_number: '123',
    })
  })

  it('coerces array values into a single comma-joined string', () => {
    expect(stripReservedParams({ tags: ['a', 'b'] })).toEqual({ tags: 'a,b' })
  })
})

describe('buildSafeQueryString', () => {
  it('returns empty string for empty input', () => {
    expect(buildSafeQueryString({})).toBe('')
  })

  it('sorts keys alphabetically for stable output', () => {
    const a = buildSafeQueryString({ b: '2', a: '1', c: '3' })
    const b = buildSafeQueryString({ a: '1', c: '3', b: '2' })
    expect(a).toBe(b)
    expect(a).toBe('a=1&b=2&c=3')
  })

  it('URL-encodes values', () => {
    expect(buildSafeQueryString({ q: 'foo bar' })).toBe('q=foo%20bar')
  })
})

describe('buildCacheKey', () => {
  it('produces the same key regardless of query param order', () => {
    const k1 = buildCacheKey('proxy', '/api/v2/x', { b: '2', a: '1' })
    const k2 = buildCacheKey('proxy', '/api/v2/x', { a: '1', b: '2' })
    expect(k1).toBe(k2)
  })

  it('ignores reserved params so apikey junk does not balloon the cache', () => {
    const clean = buildCacheKey('proxy', '/api/v2/x', { foo: 'bar' })
    const noisy = buildCacheKey('proxy', '/api/v2/x', { foo: 'bar', apikey: 'evil' })
    expect(clean).toBe(noisy)
  })

  it('caps total key length so abusive clients cannot exhaust Redis keyspace', () => {
    const huge = 'x'.repeat(5000)
    const key = buildCacheKey('proxy', '/api/v2/x', { foo: huge })
    expect(key.length).toBeLessThanOrEqual(512)
  })

  it('includes namespace prefix', () => {
    expect(buildCacheKey('proxy', '/p', {})).toMatch(/^proxy:/)
  })
})
