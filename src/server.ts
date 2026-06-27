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

const blockscoutBaseUrl = process.env.BLOCKSCOUT_BASE_URL
if (blockscoutBaseUrl && !blockscoutBaseUrl.startsWith('https://')) {
  log.error(
    `FATAL: BLOCKSCOUT_BASE_URL must start with https:// (got: ${blockscoutBaseUrl})`,
  )
  process.exit(1)
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
