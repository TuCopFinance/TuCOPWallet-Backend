import type Redis from 'ioredis'

export const WRI_RATE_LIMIT_WINDOW_SECONDS = 300

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
  inMemoryStore.set(key, { expiresAt: now + WRI_RATE_LIMIT_WINDOW_SECONDS * 1000 })
  return { acquired: true }
}

export function _resetInMemoryStoreForTests(): void {
  inMemoryStore.clear()
}
