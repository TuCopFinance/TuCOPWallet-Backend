import Redis from 'ioredis'
import { createLogger } from './logger'

const log = createLogger('lib:redis')

let client: Redis | null | undefined

export function getRedis(): Redis | null {
  if (client !== undefined) return client

  const url = process.env.REDIS_URL
  if (!url || url === 'disabled') {
    client = null
    return null
  }

  const isRailwayInternal = url.includes('.railway.internal')

  client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    ...(isRailwayInternal ? { family: 6 } : {}),
  })
  client.on('error', (err) => {
    log.warn('connection error:', err instanceof Error ? err.message : err)
  })
  return client
}
