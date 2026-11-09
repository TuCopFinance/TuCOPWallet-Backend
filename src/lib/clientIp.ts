import { isIP } from 'node:net'

// End-user IP for the TuCOPRamp relay header (X-TuCOPRamp-Client-IP).
//
// TuCOPRamp marked this backend as a trusted relay, so its per-IP limits key
// on the address this header carries instead of the Railway egress address
// every request arrives from. Without the header all of our users share one
// bucket; with a WRONG address they share one bucket AND we have told upstream
// something false. So the only address worth sending is one that could really
// be an end user on the public internet: anything else (a private range that
// several distinct users would collide on, a loopback address, garbage from a
// header we should not have trusted) is strictly worse than sending nothing.
//
// Upstream applies the same IPv4-mapped unwrapping (TuCOPRamp
// server/src/middleware/client-ip.ts normalizeClientIp), so `::ffff:1.2.3.4`
// and `1.2.3.4` land in the same bucket there. We unwrap BEFORE classifying
// because Railway hands Express the mapped form on some paths, and a mapped
// address classified as IPv6 would sail past every IPv4 private-range check.

const MAX_IP_TEXT_LENGTH = 45

// RFC 6890 special-purpose IPv4 blocks: none of these is a public end-user
// address, and each would either collide across users or reveal nothing.
const NON_PUBLIC_V4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // this host on this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT shared space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2 (documentation)
  ['203.0.113.0', 24], // TEST-NET-3 (documentation)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255 broadcast
]

// Same idea for IPv6. Expressed as a prefix length over the 16 address bytes.
const NON_PUBLIC_V6_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let acc = 0
  for (const part of parts) {
    // Reject empty, non-numeric, out-of-range and zero-padded octets so a
    // string like `010.1.1.1` (octal in some resolvers) never classifies.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    acc = acc * 256 + octet
  }
  return acc
}

// Expand an IPv6 literal to its 16 bytes. `isIP` has already accepted the
// shape, so this only has to handle `::` compression and an embedded IPv4
// tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`).
function v6ToBytes(ip: string): Uint8Array | null {
  const [head, tail, ...rest] = ip.split('::')
  if (rest.length > 0) return null

  const expand = (group: string | undefined): number[] | null => {
    if (!group) return []
    const out: number[] = []
    const hextets = group.split(':')
    for (let i = 0; i < hextets.length; i++) {
      const hextet = hextets[i]!
      if (hextet.includes('.')) {
        // Embedded IPv4 is only legal as the final 32 bits.
        if (i !== hextets.length - 1) return null
        const asInt = v4ToInt(hextet)
        if (asInt === null) return null
        out.push((asInt >>> 24) & 0xff, (asInt >>> 16) & 0xff, (asInt >>> 8) & 0xff, asInt & 0xff)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null
      const value = Number.parseInt(hextet, 16)
      out.push((value >> 8) & 0xff, value & 0xff)
    }
    return out
  }

  const headBytes = expand(head)
  const tailBytes = tail === undefined ? [] : expand(tail)
  if (headBytes === null || tailBytes === null) return null

  if (tail === undefined) {
    // No `::`, so the address must already be complete.
    return headBytes.length === 16 ? Uint8Array.from(headBytes) : null
  }
  const zeros = 16 - headBytes.length - tailBytes.length
  if (zeros < 0) return null
  return Uint8Array.from([...headBytes, ...new Array<number>(zeros).fill(0), ...tailBytes])
}

function inV4Block(addr: number, block: string, prefixLength: number): boolean {
  const base = v4ToInt(block)
  if (base === null) return false
  // `>>> 0` keeps the mask unsigned; a /0 would shift by 32 (undefined in JS),
  // but no block here uses /0.
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0)
}

function inV6Block(addr: Uint8Array, block: string, prefixLength: number): boolean {
  const base = v6ToBytes(block)
  if (base === null) return false
  const fullBytes = prefixLength >> 3
  for (let i = 0; i < fullBytes; i++) {
    if (addr[i] !== base[i]) return false
  }
  const remainingBits = prefixLength & 7
  if (remainingBits === 0) return true
  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (addr[fullBytes]! & mask) === (base[fullBytes]! & mask)
}

// The single public address to advertise upstream, or null when there is
// nothing we would be honest sending. Accepts whatever Express put in
// `req.ip`, including the IPv4-mapped IPv6 form.
export function publicClientIp(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_IP_TEXT_LENGTH) return null

  // A zone index only ever decorates a link-local address, which is not
  // public, and `isIP` rejects the form anyway.
  if (trimmed.includes('%')) return null

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed)
  const candidate = mapped ? mapped[1]! : trimmed

  const version = isIP(candidate)
  if (version === 4) {
    const addr = v4ToInt(candidate)
    if (addr === null) return null
    for (const [block, prefixLength] of NON_PUBLIC_V4_BLOCKS) {
      if (inV4Block(addr, block, prefixLength)) return null
    }
    return candidate
  }
  if (version === 6) {
    const bytes = v6ToBytes(candidate)
    if (bytes === null) return null
    for (const [block, prefixLength] of NON_PUBLIC_V6_BLOCKS) {
      if (inV6Block(bytes, block, prefixLength)) return null
    }
    return candidate.toLowerCase()
  }
  return null
}
