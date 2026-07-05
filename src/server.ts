// Sentry MUST be initialised before any other import that could throw at
// load time, so the SDK can attach its async-context hooks first.
import { initSentry } from './lib/sentry'
initSentry()

// Typed env validation runs BEFORE any other import that reads env at module
// load time. parseEnv() throws a multi-issue error if any required var is
// missing or any var is malformed; we exit non-zero so a misconfigured
// deploy fails immediately instead of returning 503 at the first request
// that touches the missing config.
import { parseEnv } from './lib/env'
import { createLogger } from './lib/logger'

const log = createLogger('server')

try {
  parseEnv()
} catch (err) {
  log.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

import { app } from './app'
import { runMigrations } from './db/migrate'
import { getDb } from './lib/db'
import { startNeeruIndexer } from './neeru-indexer/worker'
import { startTimelockIndexer } from './neeru-timelock/worker'
import { startIndexer } from './transactions-indexer/worker'

const PORT = Number(process.env.PORT) || 8080

// Blockscout proxy host allowlist. The previous check only enforced https://
// which left BLOCKSCOUT_BASE_URL trusted beyond the protocol; a misconfigured
// deploy or env-var hijack could turn the /api/v2/* routes into a generic
// SSRF gateway. Hosts must explicitly appear here. Operators add via the
// BLOCKSCOUT_ALLOWED_HOSTS env (comma-separated) when adding a new chain.
//
// `api.blockscout.com` is the Blockscout multichain Pro gateway (path-prefixed
// by chainId, e.g. /42220). Production uses this because the Pro API key was
// issued against it. `celo.blockscout.com` is the public per-chain instance.
const BLOCKSCOUT_DEFAULT_ALLOWED_HOSTS = [
  'celo.blockscout.com',
  'api.blockscout.com',
]

const blockscoutBaseUrl = process.env.BLOCKSCOUT_BASE_URL
if (blockscoutBaseUrl) {
  let parsed: URL
  try {
    parsed = new URL(blockscoutBaseUrl)
  } catch {
    log.error(`FATAL: BLOCKSCOUT_BASE_URL is not a valid URL (got: ${blockscoutBaseUrl})`)
    process.exit(1)
    throw new Error('unreachable')
  }
  if (parsed.protocol !== 'https:') {
    log.error(`FATAL: BLOCKSCOUT_BASE_URL must use https:// (got: ${blockscoutBaseUrl})`)
    process.exit(1)
  }
  const extra = (process.env.BLOCKSCOUT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const allowed = new Set([...BLOCKSCOUT_DEFAULT_ALLOWED_HOSTS, ...extra])
  if (!allowed.has(parsed.hostname.toLowerCase())) {
    log.error(
      `FATAL: BLOCKSCOUT_BASE_URL hostname "${parsed.hostname}" is not in the allowlist. ` +
        `Allowed hosts: ${[...allowed].join(', ')}. ` +
        `Add to BLOCKSCOUT_ALLOWED_HOSTS (comma-separated) if intentional.`,
    )
    process.exit(1)
  }
}

async function boot(): Promise<void> {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== 'disabled') {
    try {
      const result = await runMigrations()
      if (result.applied.length > 0) {
        log.info(`migrations applied: ${result.applied.join(', ')}`)
      }
    } catch (err) {
      log.error(
        `FATAL: migration run failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
  }

  app.listen(PORT, () => {
    log.info(`tucopwallet-backend listening on :${PORT}`)
  })

  // Graceful shutdown: SIGTERM (Railway's standard pod-stop signal) +
  // SIGINT (Ctrl+C in dev) flip the AbortController so the transactions
  // indexer finishes its current tick instead of being killed mid-INSERT.
  // Neeru indexer's lock release is in finally + per-batch BEGIN/COMMIT, so
  // its mid-tick crash is already idempotent and doesn't need the signal
  // hook today; revisit if Neeru gains long-running per-tick state.
  const indexerAbort = new AbortController()
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      log.info(`${sig} received; aborting indexer + draining`)
      indexerAbort.abort()
    })
  }

  if (process.env.INDEXER_ENABLED === 'true') {
    startIndexer({ signal: indexerAbort.signal }).catch((err) => {
      log.error(`indexer crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  if (process.env.NEERU_INDEXER_ENABLED === 'true') {
    startNeeruIndexer({ db: getDb()! }).catch((err) => {
      log.error(`neeru indexer crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  if (process.env.NEERU_TIMELOCK_ENABLED === 'true') {
    startTimelockIndexer({ db: getDb()! }).catch((err) => {
      log.error(`neeru timelock indexer crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}

void boot()
