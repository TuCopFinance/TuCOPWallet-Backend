// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Health probes".
// Public docs: `docs/api.md` sections "/health", "/ready", "/health/relay",
// "/metrics". Any change to `/ready` field shape or warmup gate behavior
// must update both.
import { Router, Request, Response } from 'express'
import { isNeeruWarmupReady } from '../hooks-api/neeru/warmup'
import { getCeloPublicClient } from '../lib/celoClient'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { metricsRegistry, refreshRelayBalanceMetric } from '../lib/metrics'
import { getRedis } from '../lib/redis'
import { getRelayClients } from '../lib/wriRelay'
import { getSharedNeeruRpc } from '../neeru-indexer/rpc'

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
    // Prefer the shared Neeru RPC client when the warmup path is enabled,
    // so /ready reflects "can we serve requests via the fallback chain?"
    // rather than "is forno alone happy?". Otherwise fall back to the
    // legacy singleton (forno direct) so envs without Neeru configured
    // still see meaningful readiness. Rate-limits or Cloudflare bans on a
    // single upstream (observed forno 429 on our Railway IP 2026-08-04)
    // then do not 503 the deploy since the shared client cascades.
    const client =
      process.env.NEERU_INDEXER_ENABLED === 'true'
        ? getSharedNeeruRpc()
        : getCeloPublicClient()
    // Widen the timeout when using the shared client because the fallback
    // path can legitimately take a couple of seconds when the primary is
    // being cascaded. Keep it tight for the legacy single-endpoint probe.
    const timeoutMs =
      process.env.NEERU_INDEXER_ENABLED === 'true'
        ? PROBE_TIMEOUT_MS * 5
        : PROBE_TIMEOUT_MS
    await withTimeout(client.getBlockNumber(), timeoutMs, 'rpc')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Liveness probe. Used by Railway to decide whether the process is responsive.
// Returns 200 as long as the process can handle a request - dependencies are
// NOT checked here on purpose. Use /ready for dependency health.
//
// Two paths: `/health` (canonical, kept for Railway healthcheckPath config)
// and `/api/health` (alias, matches the `/api/*` convention wallets expect
// for platform endpoints). Both share the same handler.
function livenessHandler(_req: Request, res: Response): void {
  res.json({ ok: true, service: 'tucopwallet-backend', version: '0.1.0' })
}
router.get('/health', livenessHandler)
router.get('/api/health', livenessHandler)

// Readiness probe. Checks every external dependency the routes depend on.
// Returns 503 when any required dependency is down. Operator alerts should
// page on /ready 503s, not /health. Aliased at `/api/ready` for symmetry
// with `/api/health`. When it 503s the response carries `Retry-After: 30`
// via retryAfterMiddleware in app.ts so clients back off.
async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const [db, redis, rpc] = await Promise.all([probeDb(), probeRedis(), probeRpc()])
  // When the Neeru warmup is running (NEERU_INDEXER_ENABLED=true at boot),
  // gate readiness on its first tick completing so Railway does not route
  // traffic to a container whose shared Neeru RPC client has never opened
  // a socket. Without this the very first request post-deploy still pays
  // the cold TLS reconnect (measured 16.5s on the fix deploy 2026-08-04
  // when the request landed before the warmup's first tick finished).
  // Warmup off (tests, envs without the flag) skips this check entirely.
  const warmupEnabled = process.env.NEERU_INDEXER_ENABLED === 'true'
  const warmupReady = warmupEnabled ? isNeeruWarmupReady() : true
  const allOk = db.ok && redis.ok && rpc.ok && warmupReady
  res.status(allOk ? 200 : 503).json({
    ok: allOk,
    checks: {
      db: db.ok ? 'ok' : `fail: ${db.error}`,
      redis: redis.ok ? 'ok' : `fail: ${redis.error}`,
      rpc: rpc.ok ? 'ok' : `fail: ${rpc.error}`,
      ...(warmupEnabled ? { neeruWarmup: warmupReady ? 'ok' : 'warming' } : {}),
    },
  })
}
router.get('/ready', readinessHandler)
router.get('/api/ready', readinessHandler)

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
