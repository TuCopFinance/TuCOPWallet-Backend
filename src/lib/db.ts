import { Pool, type PoolConfig } from 'pg'
import { createLogger } from './logger'

const log = createLogger('lib:db')

let pool: Pool | null | undefined

export function getDb(): Pool | null {
  if (pool !== undefined) return pool

  const url = process.env.DATABASE_URL
  if (!url || url === 'disabled') {
    pool = null
    return null
  }

  // Railway internal hostnames are IPv6-only (mirrors the redis pattern in
  // src/lib/redis.ts). When pointed at *.railway.internal we force IPv6 via
  // the host parsed below; for everything else we trust the URL as-is.
  const config: PoolConfig = { connectionString: url }
  pool = new Pool(config)
  pool.on('error', (err) => {
    log.warn('pool error:', err instanceof Error ? err.message : err)
  })
  return pool
}

export function _resetDbForTests(): void {
  if (pool) {
    pool.end().catch(() => {})
  }
  pool = undefined
}
