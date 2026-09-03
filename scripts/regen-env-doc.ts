// Regenerate the "Backend kill switches" audit for the wallet spec.
// Parses src/lib/env.ts with regex + reports drift vs the kill-switch table
// in tasks/specs/wallet-consumer-spec.md. Does NOT auto-rewrite the table
// (semantics per var are too rich for a regex to preserve). Detection over
// silent regeneration. Reviewer sees the drift and updates manually.
//
// Usage: yarn docs:env
//
// Exit 0 when spec and env.ts agree, exit 1 on drift.

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ENV_PATH = resolve(__dirname, '..', 'src', 'lib', 'env.ts')
const SPEC_PATH = resolve(
  __dirname,
  '..',
  'tasks',
  'specs',
  'wallet-consumer-spec.md',
)

function fatal(msg: string): never {
  process.stderr.write(`docs:env FATAL: ${msg}\n`)
  process.exit(1)
}

if (!existsSync(ENV_PATH)) fatal(`env.ts not found at ${ENV_PATH}`)
if (!existsSync(SPEC_PATH)) fatal(`wallet spec not found at ${SPEC_PATH}`)

const envSource = readFileSync(ENV_PATH, 'utf8')
const specSource = readFileSync(SPEC_PATH, 'utf8')

// Loose regex: any line starting with two spaces + ALL_CAPS_UNDERSCORE +
// colon in env.ts is a zod field declaration. False positives are cheap.
const ENV_VAR_RE = /^\s{2}([A-Z][A-Z0-9_]{2,}):\s/gm
const envVarsInSource = new Set<string>()
let m: RegExpExecArray | null
while ((m = ENV_VAR_RE.exec(envSource)) !== null) {
  envVarsInSource.add(m[1]!)
}

const killSection = specSource.match(/## Backend kill switches[\s\S]*?(?=\n## )/)
if (!killSection) {
  fatal('could not locate "## Backend kill switches" section in the spec')
}

// Each table row starts with `| \`ENV_VAR\` |`.
const SPEC_VAR_RE = /^\|\s*`([A-Z][A-Z0-9_]{2,})`\s*\|/gm
const envVarsInSpec = new Set<string>()
while ((m = SPEC_VAR_RE.exec(killSection[0])) !== null) {
  envVarsInSpec.add(m[1]!)
}

// Vars documented elsewhere in the spec (endpoint bodies) or that are not
// wallet-facing kill switches. Add cautiously — every entry silences a
// potential drift signal.
const IGNORE = new Set<string>([
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'SENTRY_DSN',
  'SENTRY_TRACES_SAMPLE_RATE',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_PROJECT_ID',
  'CORS_WRITE_ALLOWED_ORIGINS',
  'FORNO_URL',
  'PRIMARY_RPC_URL',
  'ANKR_RPC_URL',
  'DRPC_RPC_URL',
  'ALCHEMY_RPC_URL',
  'BLOCKSCOUT_BASE_URL',
  'BLOCKSCOUT_ALLOWED_HOSTS',
  'BLOCKSCOUT_API_KEY',
  'COINMARKETCAP_API_KEY',
  'ETHERSCAN_API_KEY',
  'SQUID_INTEGRATOR_ID',
  'WRI_RELAY_PK',
  'WRI_RELAY_MIN_CELO_BALANCE',
  'WRI_RELAY_MAX_GAS',
  'WRI_RELAY_PER_IP_LIMIT',
  'WRI_RELAY_GLOBAL_LIMIT',
  'WRI_FEE_ADAPTER_USDC',
  'WRI_FEE_ADAPTER_USDT',
  'NEERU_CONTRACT_ADDRESS',
  'NEERU_CONTRACT_CREATED_AT_ISO',
  'NEERU_CONTRACT_VERSION',
  'NEERU_DEPOSIT_TOKEN_ADDRESS',
  'NEERU_MANAGE_URL',
  'NEERU_TERMS_URL',
  'NEERU_INDEXER_GENESIS_BLOCK',
  'NEERU_INDEXER_INTERVAL_MS',
  'NEERU_INDEXER_ERROR_BACKOFF_MS',
  'NEERU_EVENT_A_TOPIC0',
  'NEERU_EVENT_B_TOPIC0',
  'NEERU_EVENT_C_TOPIC0',
  'NEERU_EVENT_D_TOPIC0',
  'NEERU_DEPOSIT_EVENT_TOPIC0',
  'NEERU_TIMELOCK_ADDRESS',
  'NEERU_TIMELOCK_GENESIS_BLOCK',
  'NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0',
  'NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0',
  'NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0',
  'NEERU_CATEGORY_IMAGE_URL_TEMPLATE',
  'SQUID_INTEGRATOR_FEE_ADDRESS',
  'SQUID_INTEGRATOR_FEE_PERCENTAGE',
  'TX_INDEXER_BACKFILL_BLOCKS',
  'TX_ADMIN_TOKEN',
  // Internal tuning knobs — not user-facing kill switches. Adjust in
  // Railway env as needed for performance tuning; wallet team does not
  // need to know these.
  'PG_POOL_MAX',
  'PG_POOL_CONNECTION_TIMEOUT_MS',
  'PG_POOL_IDLE_TIMEOUT_MS',
  'NEERU_INDEXER_MAX_BLOCKS_PER_BATCH',
  'INDEXER_POLL_INTERVAL_MS',
  'INDEXER_MAX_BLOCKS_PER_TICK',
  'TX_INDEXER_BACKFILL_CHUNK_DELAY_MS',
  'TX_INDEXER_BACKFILL_MAX_DELAY_MS',
  'NEERU_TIMELOCK_INTERVAL_MS',
  'NEERU_TIMELOCK_ERROR_BACKOFF_MS',
  'NEERU_TIMELOCK_MAX_BLOCKS_PER_BATCH',
  // Backend-internal observability + ops tuning. Not wallet-facing (wallet
  // never checks these; they govern Sentry alert level escalation, indexer
  // trailing buffer, and server-side Statsig SDK auth respectively).
  'WRI_RELAY_CRITICAL_CELO_BALANCE',
  'STATSIG_SERVER_SECRET',
  'INDEXER_HEAD_LAG_BUFFER_BLOCKS',
])

const missingFromSpec = [...envVarsInSource]
  .filter((v) => !envVarsInSpec.has(v))
  .filter((v) => !IGNORE.has(v))
const staleInSpec = [...envVarsInSpec]
  .filter((v) => !envVarsInSource.has(v))
  .filter((v) => !IGNORE.has(v))

if (missingFromSpec.length === 0 && staleInSpec.length === 0) {
  process.stdout.write(
    `docs:env OK. ${envVarsInSource.size} vars in src/lib/env.ts, ${envVarsInSpec.size} in spec kill-switch table, no drift.\n`,
  )
  process.exit(0)
}

process.stderr.write('docs:env DRIFT DETECTED\n')
if (missingFromSpec.length > 0) {
  process.stderr.write(
    `\n  Env vars in src/lib/env.ts but missing from the kill-switch table:\n${missingFromSpec.map((v) => `    - ${v}`).join('\n')}\n  Add a row for each, OR add to the IGNORE set in scripts/regen-env-doc.ts if not wallet-facing.\n`,
  )
}
if (staleInSpec.length > 0) {
  process.stderr.write(
    `\n  Env vars in the spec table but no longer declared in src/lib/env.ts:\n${staleInSpec.map((v) => `    - ${v}`).join('\n')}\n`,
  )
}
process.exit(1)
