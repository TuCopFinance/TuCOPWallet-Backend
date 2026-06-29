import { Router, Request, Response } from 'express'
import { getCeloPublicClient } from '../lib/celoClient'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { metricsRegistry, refreshRelayBalanceMetric } from '../lib/metrics'
import { getRedis } from '../lib/redis'
import { getRelayClients } from '../lib/wriRelay'

const log = createLogger('routes:health')
const router = Router()

// Per-dependency probe timeout. Sub-second so /ready stays cheap; Railway's
// health check probe expects a fast response.
const PROBE_TIMEOUT_MS = 1_000

interface ProbeResult {
  ok: boolean
  error?: string
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms),
    ),
  ])
}

async function probeDb(): Promise<ProbeResult> {
  const db = getDb()
  if (!db) return { ok: true } // DB is optional; not configured == not unhealthy.
  try {
    await withTimeout(db.query('SELECT 1'), PROBE_TIMEOUT_MS, 'db')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function probeRedis(): Promise<ProbeResult> {
  const redis = getRedis()
  if (!redis) return { ok: true } // Redis is optional; same logic as db.
  try {
    await withTimeout(redis.ping(), PROBE_TIMEOUT_MS, 'redis')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function probeRpc(): Promise<ProbeResult> {
  try {
    const client = getCeloPublicClient()
    await withTimeout(client.getBlockNumber(), PROBE_TIMEOUT_MS, 'rpc')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Liveness probe. Used by Railway to decide whether the process is responsive.
// Returns 200 as long as the process can handle a request - dependencies are
// NOT checked here on purpose. Use /ready for dependency health.
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'tucopwallet-backend', version: '0.1.0' })
})

// Readiness probe. Checks every external dependency the routes depend on.
// Returns 503 when any required dependency is down. Operator alerts should
// page on /ready 503s, not /health.
router.get('/ready', async (_req: Request, res: Response) => {
  const [db, redis, rpc] = await Promise.all([probeDb(), probeRedis(), probeRpc()])
  const allOk = db.ok && redis.ok && rpc.ok
  res.status(allOk ? 200 : 503).json({
    ok: allOk,
    checks: {
      db: db.ok ? 'ok' : `fail: ${db.error}`,
      redis: redis.ok ? 'ok' : `fail: ${redis.error}`,
      rpc: rpc.ok ? 'ok' : `fail: ${rpc.error}`,
    },
  })
})

// Relay hot-wallet health. Exposes the relay address + balance (without the
// private key) so external monitors can alert on low balance without needing
// a Sentry/Grafana integration. Returns 200 even when balance is low - the
// caller decides what threshold to alert on.
router.get('/health/relay', async (_req: Request, res: Response) => {
  const relay = getRelayClients()
  if (!relay) {
    return res
      .status(503)
      .json({ ok: false, error: 'relay not configured (WRI_RELAY_PK missing or invalid)' })
  }
  try {
    const balanceWei = await withTimeout(
      relay.publicClient.getBalance({ address: relay.account.address }),
      PROBE_TIMEOUT_MS,
      'rpc',
    )
    return res.json({
      ok: true,
      address: relay.account.address,
      balanceWei: balanceWei.toString(),
      balanceCelo: (Number(balanceWei) / 1e18).toString(),
    })
  } catch (err) {
    log.warn('relay health probe failed:', err instanceof Error ? err.message : err)
    return res
      .status(502)
      .json({ ok: false, error: 'rpc unavailable', address: relay.account.address })
  }
})

// Prometheus scrape endpoint. Refreshes the relay balance gauge before
// emitting so the value is current when the scrape lands.
router.get('/metrics', async (_req: Request, res: Response) => {
  await refreshRelayBalanceMetric()
  res.setHeader('content-type', metricsRegistry.contentType)
  res.send(await metricsRegistry.metrics())
})

export default router
