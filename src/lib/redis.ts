import Redis from 'ioredis'

let client: Redis | null | undefined

export function getRedis(): Redis | null {
  if (client !== undefined) return client

  const url = process.env.REDIS_URL
  if (!url) {
    client = null
    return null
  }

  client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  })
  client.on('error', (err) => {
    console.warn('redis error:', err instanceof Error ? err.message : err)
  })
  return client
}
