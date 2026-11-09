import { publicClientIp } from './clientIp'

describe('publicClientIp', () => {
  it('accepts a public IPv4 address unchanged', () => {
    expect(publicClientIp('8.8.8.8')).toBe('8.8.8.8')
    expect(publicClientIp('1.1.1.1')).toBe('1.1.1.1')
    expect(publicClientIp('190.85.12.34')).toBe('190.85.12.34')
  })

  it('accepts a public IPv6 address, lowercased', () => {
    expect(publicClientIp('2606:4700:4700::1111')).toBe('2606:4700:4700::1111')
    expect(publicClientIp('2001:4860:4860::8888')).toBe('2001:4860:4860::8888')
    expect(publicClientIp('2606:4700:4700::1111'.toUpperCase())).toBe('2606:4700:4700::1111')
  })

  it('unwraps the IPv4-mapped IPv6 form Railway can hand Express', () => {
    // Upstream normalizes the same way, so both forms must land in one
    // rate-limit bucket there.
    expect(publicClientIp('::ffff:8.8.8.8')).toBe('8.8.8.8')
    expect(publicClientIp('::FFFF:8.8.8.8')).toBe('8.8.8.8')
  })

  it('rejects a mapped private address instead of passing it off as IPv6', () => {
    // The regression this guards: classifying `::ffff:10.0.0.1` as IPv6 skips
    // every IPv4 private-range check and leaks a private address upstream.
    expect(publicClientIp('::ffff:10.0.0.1')).toBeNull()
    expect(publicClientIp('::ffff:192.168.1.5')).toBeNull()
    expect(publicClientIp('::ffff:127.0.0.1')).toBeNull()
  })

  it('rejects private, loopback, link-local and CGNAT IPv4', () => {
    expect(publicClientIp('10.0.0.1')).toBeNull()
    expect(publicClientIp('10.255.255.255')).toBeNull()
    expect(publicClientIp('172.16.0.1')).toBeNull()
    expect(publicClientIp('172.31.255.255')).toBeNull()
    expect(publicClientIp('192.168.1.1')).toBeNull()
    expect(publicClientIp('127.0.0.1')).toBeNull()
    expect(publicClientIp('169.254.1.1')).toBeNull()
    expect(publicClientIp('100.64.0.1')).toBeNull()
    expect(publicClientIp('0.0.0.0')).toBeNull()
  })

  it('keeps the neighbours of each private block public', () => {
    // Off-by-one on a CIDR mask is the easy bug here.
    expect(publicClientIp('9.255.255.255')).toBe('9.255.255.255')
    expect(publicClientIp('11.0.0.0')).toBe('11.0.0.0')
    expect(publicClientIp('172.15.255.255')).toBe('172.15.255.255')
    expect(publicClientIp('172.32.0.0')).toBe('172.32.0.0')
    expect(publicClientIp('192.167.255.255')).toBe('192.167.255.255')
    expect(publicClientIp('192.169.0.0')).toBe('192.169.0.0')
    expect(publicClientIp('100.63.255.255')).toBe('100.63.255.255')
    expect(publicClientIp('100.128.0.0')).toBe('100.128.0.0')
  })

  it('rejects multicast, reserved, broadcast and documentation IPv4', () => {
    expect(publicClientIp('224.0.0.1')).toBeNull()
    expect(publicClientIp('239.255.255.255')).toBeNull()
    expect(publicClientIp('240.0.0.1')).toBeNull()
    expect(publicClientIp('255.255.255.255')).toBeNull()
    expect(publicClientIp('192.0.2.1')).toBeNull()
    expect(publicClientIp('198.51.100.1')).toBeNull()
    expect(publicClientIp('203.0.113.1')).toBeNull()
    expect(publicClientIp('198.18.0.1')).toBeNull()
    expect(publicClientIp('192.0.0.1')).toBeNull()
    expect(publicClientIp('192.88.99.1')).toBeNull()
  })

  it('rejects loopback, unspecified, unique-local, link-local and multicast IPv6', () => {
    expect(publicClientIp('::')).toBeNull()
    expect(publicClientIp('::1')).toBeNull()
    expect(publicClientIp('fc00::1')).toBeNull()
    expect(publicClientIp('fd12:3456::1')).toBeNull()
    expect(publicClientIp('fdff:ffff::1')).toBeNull()
    expect(publicClientIp('fe80::1')).toBeNull()
    expect(publicClientIp('febf::1')).toBeNull()
    expect(publicClientIp('ff02::1')).toBeNull()
    expect(publicClientIp('2001:db8::1')).toBeNull()
    expect(publicClientIp('100::1')).toBeNull()
  })

  it('keeps the neighbours of each IPv6 block public', () => {
    expect(publicClientIp('fbff::1')).toBe('fbff::1')
    expect(publicClientIp('fec0::1')).toBe('fec0::1')
    expect(publicClientIp('2001:db9::1')).toBe('2001:db9::1')
    expect(publicClientIp('2001:db7::1')).toBe('2001:db7::1')
  })

  it('rejects garbage, empty input and absent input', () => {
    expect(publicClientIp(undefined)).toBeNull()
    expect(publicClientIp(null)).toBeNull()
    expect(publicClientIp('')).toBeNull()
    expect(publicClientIp('   ')).toBeNull()
    expect(publicClientIp('not-an-ip')).toBeNull()
    expect(publicClientIp('8.8.8')).toBeNull()
    expect(publicClientIp('8.8.8.8.8')).toBeNull()
    expect(publicClientIp('999.1.1.1')).toBeNull()
    expect(publicClientIp('8.8.8.8:443')).toBeNull()
    expect(publicClientIp('<script>alert(1)</script>')).toBeNull()
  })

  it('rejects a comma-joined forwarded chain rather than sending the whole list', () => {
    // Express `req.ip` is a single address, but a mis-set header could hand us
    // the raw X-Forwarded-For list. Upstream wants one address.
    expect(publicClientIp('8.8.8.8, 1.1.1.1')).toBeNull()
    expect(publicClientIp('8.8.8.8,1.1.1.1')).toBeNull()
  })

  it('rejects a zone-indexed address', () => {
    expect(publicClientIp('fe80::1%eth0')).toBeNull()
  })

  it('rejects zero-padded IPv4 octets', () => {
    // `010.0.0.1` reads as octal to some resolvers; never forward an address
    // whose meaning depends on the parser.
    expect(publicClientIp('010.0.0.1')).toBeNull()
    expect(publicClientIp('08.8.8.8')).toBeNull()
  })

  it('rejects an over-long string without parsing it', () => {
    expect(publicClientIp('8.8.8.8'.padEnd(200, '0'))).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(publicClientIp('  8.8.8.8  ')).toBe('8.8.8.8')
  })
})
