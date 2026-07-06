// Typed env module. Validates every env var the process consumes at boot via
// zod. A misconfigured deploy (missing required var, malformed hex, etc.)
// fails immediately with a clear error instead of returning 503 at the first
// request that depends on it.
//
// The pre-existing helpers (readEnvAddress, readEnvTopic0, parseEnvBigInt,
// ZERO_ADDRESS, ZERO_TOPIC) are kept for backwards compatibility while
// consumers migrate to `env.X` access. New code should always read from the
// `env` export below, not `process.env.X`.

import { z } from 'zod'
import { HEX_ADDRESS_RE, HEX_BYTES32_RE } from './hex'
import { createLogger } from './logger'

const log = createLogger('lib:env')

// ---------------------------------------------------------------------------
// Legacy helpers (kept for backwards compatibility; existing consumers in
// neeru-indexer/abi, hooks-api/config, routes/wri still use these).
// ---------------------------------------------------------------------------

const ZERO_HEX_40 = '0x0000000000000000000000000000000000000000' as const
const ZERO_HEX_64 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const

export type ZeroAddress = typeof ZERO_HEX_40
export type ZeroTopic = typeof ZERO_HEX_64

export const ZERO_ADDRESS: ZeroAddress = ZERO_HEX_40
export const ZERO_TOPIC: ZeroTopic = ZERO_HEX_64

interface ReadEnvAddressOptions {
  lowercase?: boolean
}

export function readEnvAddress(
  name: string,
  options: ReadEnvAddressOptions = {},
): `0x${string}` {
  const v = process.env[name]
  if (!v) return ZERO_HEX_40
  if (!HEX_ADDRESS_RE.test(v)) {
    throw new Error(`${name} must be 0x + 40 hex (got: ${v.length} chars)`)
  }
  return (options.lowercase ? v.toLowerCase() : v) as `0x${string}`
}

export function readEnvTopic0(name: string): `0x${string}` {
  const v = process.env[name]
  if (!v) return ZERO_HEX_64
  if (!HEX_BYTES32_RE.test(v)) {
    throw new Error(`${name} must be 0x + 64 hex (got: ${v.length} chars)`)
  }
  return v.toLowerCase() as `0x${string}`
}

export function parseEnvBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (!raw) return fallback
  try {
    const v = BigInt(raw)
    if (v < 0n) {
      log.warn(`${name} is negative; using fallback ${fallback.toString()}`)
      return fallback
    }
    return v
  } catch {
    log.warn(
      `${name} is not a valid integer (got: "${raw}"); using fallback ${fallback.toString()}`,
    )
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Schema-driven env (new code should use this)
// ---------------------------------------------------------------------------

// zod helpers used across multiple env fields.
const zHexAddress = z
  .string()
  .regex(HEX_ADDRESS_RE, '0x + 40 hex address')
const zHexBytes32 = z
  .string()
  .regex(HEX_BYTES32_RE, '0x + 64 hex bytes32')
const zHttpsUrl = z
  .string()
  .url()
  .startsWith('https://', { message: 'must start with https://' })

// Coerce-and-default helpers for vars that can be empty/missing.
const zPositiveInt = z.coerce.number().int().nonnegative()

const envSchema = z.object({
  // Required (boot fails if missing)
  ETHERSCAN_API_KEY: z.string().min(1, 'required'),

  // Network / port
  PORT: zPositiveInt.optional().default(8080),
  NODE_ENV: z.string().optional().default('development'),

  // DB pool (optional with defaults; production reads these)
  DATABASE_URL: z.string().optional(),
  PG_POOL_MAX: zPositiveInt.optional().default(20),
  PG_POOL_CONNECTION_TIMEOUT_MS: zPositiveInt.optional().default(5_000),
  PG_POOL_IDLE_TIMEOUT_MS: zPositiveInt.optional().default(30_000),

  // Redis (sentinel "disabled" disables caching)
  REDIS_URL: z.string().optional(),

  // Celo RPC fallback chain. Order is primary -> forno -> ankr -> drpc; the
  // Neeru indexer supervisor and Allbridge's viem fallback transport both
  // consume `getCeloRpcFallbackUrls()` from lib/celoClient. All four are
  // required: the URLs are deployment-controlled configuration, not in-source
  // constants, so a deploy can rotate any endpoint without a code change.
  PRIMARY_RPC_URL: zHttpsUrl,
  FORNO_URL: zHttpsUrl,
  ANKR_RPC_URL: zHttpsUrl,
  DRPC_RPC_URL: zHttpsUrl,

  // Upstream providers (optional; routes 503 when their feature is hit
  // without the corresponding key)
  COINMARKETCAP_API_KEY: z.string().optional(),
  BLOCKSCOUT_API_KEY: z.string().optional(),
  BLOCKSCOUT_BASE_URL: zHttpsUrl.optional(),
  BLOCKSCOUT_ALLOWED_HOSTS: z.string().optional().default(''),
  SQUID_INTEGRATOR_ID: z.string().optional(),

  // WRI relay
  WRI_RELAY_PK: zHexBytes32.optional(),
  WRI_RELAY_MIN_CELO_BALANCE: z.coerce.bigint().optional(),
  WRI_RELAY_MAX_GAS: z.coerce.bigint().optional(),
  WRI_RELAY_PER_IP_LIMIT: zPositiveInt.optional().default(20),
  WRI_RELAY_GLOBAL_LIMIT: zPositiveInt.optional().default(60),

  // WRI fee-adapter bootstrap (Track C dollarsSpend chicken-and-egg fix).
  // Kill switch (default off) and per-token adapter contract addresses.
  // When _ENABLED=true, the endpoint reads adapter addresses for whichever
  // tokens are configured; missing addresses are silently skipped.
  WRI_FEE_BOOTSTRAP_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  WRI_FEE_ADAPTER_USDC: zHexAddress.optional(),
  WRI_FEE_ADAPTER_USDT: zHexAddress.optional(),

  // CORS
  CORS_WRITE_ALLOWED_ORIGINS: z.string().optional().default(''),

  // Observability
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),

  // Indexer enable flags
  INDEXER_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  NEERU_INDEXER_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  NEERU_INDEXER_INTERVAL_MS: zPositiveInt.optional().default(30_000),
  NEERU_INDEXER_ERROR_BACKOFF_MS: zPositiveInt
    .optional()
    .default(5 * 60 * 1000),
  NEERU_INDEXER_MAX_BLOCKS_PER_BATCH: z.coerce
    .bigint()
    .optional()
    .default(5_000n),

  // Transactions indexer (cross-wallet tx feed) - tunables for the
  // tip-following loop. Same units as the neeru indexer counterparts:
  // POLL_INTERVAL_MS = sleep between ticks, MAX_BLOCKS_PER_TICK = upper
  // bound on the cursor advance per iteration.
  INDEXER_POLL_INTERVAL_MS: zPositiveInt.optional().default(5_000),
  INDEXER_MAX_BLOCKS_PER_TICK: zPositiveInt.optional().default(200),
  // Historical backfill depth on first POST /api/transactions/watch. Default
  // 10_000 blocks (~14 h on Celo's 5 s blocks). Set to 0 to disable backfill.
  TX_INDEXER_BACKFILL_BLOCKS: zPositiveInt.optional().default(10_000),

  // Kill switches for /api/transactions/feed and /watch. Evaluated per-request
  // (not at boot) so the flip takes effect on the next request without a
  // Railway restart. Default true. Set to the literal string "false" to gate
  // the route to 503. Added 2026-07-05 in response to the shape-bug rollback
  // during the WRI_TX_FEED_TUCOP_V1 rollout so backend has a same-second pause
  // path independent of the wallet's Statsig gate.
  TX_FEED_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
  TX_WATCH_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),

  // Neeru contract (REQUIRED if NEERU_INDEXER_ENABLED=true; refined below)
  NEERU_INDEXER_GENESIS_BLOCK: z.coerce.bigint().optional(),
  NEERU_CONTRACT_ADDRESS: zHexAddress.optional(),
  NEERU_EVENT_A_TOPIC0: zHexBytes32.optional(),
  NEERU_EVENT_B_TOPIC0: zHexBytes32.optional(),
  NEERU_EVENT_C_TOPIC0: zHexBytes32.optional(),
  NEERU_EVENT_D_TOPIC0: zHexBytes32.optional(),

  // Neeru hooks-api / wallet surfaces (optional)
  NEERU_DEPOSIT_TOKEN_ADDRESS: zHexAddress.optional(),
  NEERU_CATEGORY_IMAGE_URL_TEMPLATE: z.string().optional().default(''),
  NEERU_MANAGE_URL: z.string().optional().default(''),
  NEERU_TERMS_URL: z.string().optional().default(''),
  NEERU_CONTRACT_CREATED_AT_ISO: z.string().datetime().optional(),

  // Timelock monitor. Watches the admin Timelock that guards the Neeru fund
  // proxy for schedule / execute / cancel events targeting the proxy address.
  // Disabled by default; when NEERU_TIMELOCK_ENABLED=true the same required
  // set as the Neeru indexer applies (DATABASE_URL etc) plus the Timelock
  // config below.
  NEERU_TIMELOCK_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  NEERU_TIMELOCK_ADDRESS: zHexAddress.optional(),
  NEERU_TIMELOCK_GENESIS_BLOCK: z.coerce.bigint().optional(),
  NEERU_TIMELOCK_INTERVAL_MS: zPositiveInt.optional().default(30_000),
  NEERU_TIMELOCK_ERROR_BACKOFF_MS: zPositiveInt.optional().default(5 * 60 * 1000),
  NEERU_TIMELOCK_MAX_BLOCKS_PER_BATCH: z.coerce.bigint().optional().default(5_000n),
  NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0: zHexBytes32.optional(),
  NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0: zHexBytes32.optional(),
  NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0: zHexBytes32.optional(),
})

export type Env = z.infer<typeof envSchema>

let cachedEnv: Env | null = null

// Parse + validate process.env once. Returns the cached value on subsequent
// calls. Throws z.ZodError with a multi-issue message if validation fails -
// the caller (server.ts) is expected to catch it, log, and exit non-zero.
export function parseEnv(): Env {
  if (cachedEnv) return cachedEnv
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ')
    throw new Error(`env validation failed:\n  ${issues}`)
  }
  // Cross-field invariants. Indexers need DB + Neeru-specific vars when on.
  const e = result.data
  if (e.NEERU_INDEXER_ENABLED) {
    const missing: string[] = []
    if (!e.DATABASE_URL || e.DATABASE_URL === 'disabled') missing.push('DATABASE_URL')
    if (e.NEERU_INDEXER_GENESIS_BLOCK == null) missing.push('NEERU_INDEXER_GENESIS_BLOCK')
    if (!e.NEERU_CONTRACT_ADDRESS) missing.push('NEERU_CONTRACT_ADDRESS')
    for (const t of [
      'NEERU_EVENT_A_TOPIC0',
      'NEERU_EVENT_B_TOPIC0',
      'NEERU_EVENT_C_TOPIC0',
      'NEERU_EVENT_D_TOPIC0',
    ] as const) {
      if (!e[t]) missing.push(t)
    }
    if (missing.length > 0) {
      throw new Error(
        `NEERU_INDEXER_ENABLED=true but these required vars are missing: ${missing.join(', ')}`,
      )
    }
  }
  if (e.INDEXER_ENABLED) {
    if (!e.DATABASE_URL || e.DATABASE_URL === 'disabled') {
      throw new Error('INDEXER_ENABLED=true but DATABASE_URL is missing or set to "disabled"')
    }
  }
  if (e.NEERU_TIMELOCK_ENABLED) {
    const missing: string[] = []
    if (!e.DATABASE_URL || e.DATABASE_URL === 'disabled') missing.push('DATABASE_URL')
    if (!e.NEERU_TIMELOCK_ADDRESS) missing.push('NEERU_TIMELOCK_ADDRESS')
    if (e.NEERU_TIMELOCK_GENESIS_BLOCK == null) missing.push('NEERU_TIMELOCK_GENESIS_BLOCK')
    if (!e.NEERU_CONTRACT_ADDRESS) missing.push('NEERU_CONTRACT_ADDRESS')
    for (const t of [
      'NEERU_TIMELOCK_EVENT_SCHEDULED_TOPIC0',
      'NEERU_TIMELOCK_EVENT_EXECUTED_TOPIC0',
      'NEERU_TIMELOCK_EVENT_CANCELLED_TOPIC0',
    ] as const) {
      if (!e[t]) missing.push(t)
    }
    if (missing.length > 0) {
      throw new Error(
        `NEERU_TIMELOCK_ENABLED=true but these required vars are missing: ${missing.join(', ')}`,
      )
    }
  }
  cachedEnv = e
  return e
}

// Test-only escape hatch.
export function _resetParsedEnvForTests(): void {
  cachedEnv = null
}

// Lazy proxy: `env.X` reads invoke parseEnv() on first access. Consumers
// don't have to call parseEnv() explicitly; server.ts does that at boot to
// surface errors early.
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return (parseEnv() as unknown as Record<string, unknown>)[prop]
  },
})
