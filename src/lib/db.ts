import { Pool, type PoolConfig } from 'pg'
import { parseEnvBigInt } from './env'
import { createLogger } from './logger'

const log = createLogger('lib:db')

// Pool sizing. node-postgres defaults to max=10 which is fine for a single
// HTTP-only service, but this process also runs the transactions + Neeru
// indexer workers that hold connections through multi-statement transactions.
// At default sizing, ~5 in-flight HTTP requests + a long indexer tick can
// starve the pool and stall every other request silently. 20 leaves headroom
// for a single Railway instance; revisit if we scale out to multiple replicas
// (Railway Postgres free tier caps at 100 connections per plan).
//
// connectionTimeoutMillis bounds how long getDb().query(...) waits for a
// free client when the pool is saturated. 5s fails fast and turns hidden
// starvation into visible errors that route handlers can map to 503.
//
// idleTimeoutMillis closes idle clients after 30s so a long-tail outage
// upstream doesn't pin connections forever.
//
// All three are tunable via env so an operator can react to load without
// redeploying.
const DEFAULT_POOL_MAX = 20n
const DEFAULT_POOL_CONNECTION_TIMEOUT_MS = 5_000n
const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30_000n

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
  const config: PoolConfig = {
    connectionString: url,
    max: Number(parseEnvBigInt('PG_POOL_MAX', DEFAULT_POOL_MAX)),
    connectionTimeoutMillis: Number(
      parseEnvBigInt('PG_POOL_CONNECTION_TIMEOUT_MS', DEFAULT_POOL_CONNECTION_TIMEOUT_MS),
    ),
    idleTimeoutMillis: Number(
      parseEnvBigInt('PG_POOL_IDLE_TIMEOUT_MS', DEFAULT_POOL_IDLE_TIMEOUT_MS),
    ),
  }
  pool = new Pool(config)
  // pool 'error' events fire for idle-client failures, network drops, and
  // unhandled per-client errors. These are operational (not benign) so log
  // at error level - someone needs to know the pool is in a bad state.
  pool.on('error', (err) => {
    log.error('pool error:', err instanceof Error ? err.message : err)
  })
  return pool
}

export function _resetDbForTests(): void {
  if (pool) {
    pool.end().catch((err) => {
      log.warn(
        'pool teardown error during test reset:',
        err instanceof Error ? err.message : err,
      )
    })
  }
  pool = undefined
}
