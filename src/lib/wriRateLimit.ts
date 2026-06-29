import type Redis from 'ioredis'

export const WRI_RATE_LIMIT_WINDOW_SECONDS = 300

// Global token-bucket window for /api/wri/delegate-relay. Sized so the relay
// hot wallet can't be drained by address-spraying within a single minute even
// if the per-address and per-IP tiers are bypassed. Tunable via env.
export const WRI_GLOBAL_LIMIT_WINDOW_SECONDS = 60
export const WRI_GLOBAL_LIMIT_DEFAULT = 60

// Cap on the in-memory fallback Map so a sustained Redis-outage + attack
// spray can't blow process memory. Old entries are pruned per call, but a
// brand-new address sprayer can still grow the map unbounded - this cap
// rejects (returns acquired=false) once the map is full instead of growing.
const IN_MEMORY_MAX_ENTRIES = 10_000

interface InMemoryEntry {
  expiresAt: number
}

const inMemoryStore = new Map<string, InMemoryEntry>()

function pruneExpired(now: number): void {
  for (const [key, entry] of inMemoryStore) {
    if (entry.expiresAt <= now) {
      inMemoryStore.delete(key)
    }
  }
}

export async function tryAcquireDelegateRelaySlot(
  redis: Redis | null,
  addressLower: string,
): Promise<{ acquired: boolean; ttlSeconds?: number }> {
  const key = `delegate-relay:${addressLower}`

  if (redis) {
    const ok = await redis.set(key, '1', 'EX', WRI_RATE_LIMIT_WINDOW_SECONDS, 'NX')
    if (ok === 'OK') return { acquired: true }
    const ttl = await redis.ttl(key)
    return { acquired: false, ttlSeconds: ttl > 0 ? ttl : WRI_RATE_LIMIT_WINDOW_SECONDS }
  }

  const now = Date.now()
  pruneExpired(now)
  const existing = inMemoryStore.get(key)
  if (existing && existing.expiresAt > now) {
    return { acquired: false, ttlSeconds: Math.ceil((existing.expiresAt - now) / 1000) }
  }
  if (inMemoryStore.size >= IN_MEMORY_MAX_ENTRIES) {
    // Fail-closed when the in-memory fallback is saturated. A sustained
    // Redis outage during an attack should NOT amplify into memory growth.
    return { acquired: false, ttlSeconds: WRI_RATE_LIMIT_WINDOW_SECONDS }
  }
  inMemoryStore.set(key, { expiresAt: now + WRI_RATE_LIMIT_WINDOW_SECONDS * 1000 })
  return { acquired: true }
}

// Global token bucket for /api/wri/delegate-relay. Caps total relay submissions
// (across ALL addresses + IPs) per window so a million-address spray cannot
// drain the hot wallet even if it bypasses per-address and per-IP tiers.
//
// Redis-only: the in-memory fallback is per-instance and would give each
// replica its own bucket, multiplying the effective limit by N replicas.
// Fail-closed when Redis is unavailable so the relay never serves uncapped.
export async function tryAcquireGlobalRelaySlot(
  redis: Redis | null,
  limit: number,
  windowSeconds: number = WRI_GLOBAL_LIMIT_WINDOW_SECONDS,
): Promise<{ acquired: boolean; ttlSeconds?: number; count?: number }> {
  if (!redis) {
    // No Redis = no shared state = no global bucket. Caller must treat as
    // "rate limiter unavailable" (return 503) rather than bypass.
    return { acquired: false, ttlSeconds: windowSeconds }
  }
  const key = 'delegate-relay:global'
  const count = await redis.incr(key)
  if (count === 1) {
    // First request of the window sets the TTL. INCR is atomic so only one
    // request sees count===1; the EXPIRE-vs-INCR race is impossible.
    await redis.expire(key, windowSeconds)
  }
  if (count > limit) {
    const ttl = await redis.ttl(key)
    return {
      acquired: false,
      ttlSeconds: ttl > 0 ? ttl : windowSeconds,
      count,
    }
  }
  return { acquired: true, count }
}

export function _resetInMemoryStoreForTests(): void {
  inMemoryStore.clear()
}
