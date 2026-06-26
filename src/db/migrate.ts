import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'

const log = createLogger('db:migrate')

const MIGRATIONS_DIR = join(__dirname, 'migrations')

async function ensureMigrationsTable(): Promise<void> {
  const db = getDb()
  if (!db) return
  await db.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name       text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const db = getDb()
  if (!db) {
    log.warn('DATABASE_URL not configured; skipping migrations')
    return { applied: [], skipped: [] }
  }

  await ensureMigrationsTable()

  const files = listMigrations()
  const { rows } = await db.query<{ name: string }>('SELECT name FROM _migrations')
  const applied = new Set(rows.map((r) => r.name))

  const appliedNow: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file)
      continue
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      log.info(`applied migration: ${file}`)
      appliedNow.push(file)
    } catch (err) {
      await client.query('ROLLBACK')
      log.error(
        `migration failed: ${file}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    } finally {
      client.release()
    }
  }

  return { applied: appliedNow, skipped }
}
