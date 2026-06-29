import { app } from './app'
import { runMigrations } from './db/migrate'
import { getDb } from './lib/db'
import { createLogger } from './lib/logger'
import { startNeeruIndexer } from './neeru-indexer/worker'
import { startIndexer } from './transactions-indexer/worker'

const log = createLogger('server')
const PORT = Number(process.env.PORT) || 8080

if (!process.env.ETHERSCAN_API_KEY) {
  log.error('FATAL: ETHERSCAN_API_KEY env var is required')
  process.exit(1)
}

// Blockscout proxy host allowlist. The previous check only enforced https://
// which left BLOCKSCOUT_BASE_URL trusted beyond the protocol; a misconfigured
// deploy or env-var hijack could turn the /api/v2/* routes into a generic
// SSRF gateway. Hosts must explicitly appear here. Operators add via the
// BLOCKSCOUT_ALLOWED_HOSTS env (comma-separated) when adding a new chain.
const BLOCKSCOUT_DEFAULT_ALLOWED_HOSTS = ['celo.blockscout.com']

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

  if (process.env.INDEXER_ENABLED === 'true') {
    startIndexer().catch((err) => {
      log.error(`indexer crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  if (process.env.NEERU_INDEXER_ENABLED === 'true') {
    startNeeruIndexer({ db: getDb()! }).catch((err) => {
      log.error(`neeru indexer crashed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}

void boot()
