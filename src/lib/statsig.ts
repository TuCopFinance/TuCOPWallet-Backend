import type { Statsig, StatsigUser } from '@statsig/statsig-node-core'
import { createLogger } from './logger'
import { hashWalletAddress } from './pii'
export type { StatsigUser }

const log = createLogger('lib:statsig')

// Single process-wide client. `initialize()` is awaited at boot so
// gate-check evaluations are synchronous local reads. Idempotent: a
// second `initStatsig()` call after the first init is a no-op.
//
// The `@statsig/statsig-node-core` package is a native (Rust-backed)
// module. Loading it eagerly adds ~1-2s to every jest worker cold
// start, which pushes some slow test suites past the default 5s
// timeout. We defer the require until `initStatsig()` actually runs
// so tests (which never call initStatsig) do not pay the cost.
let client: Statsig | null = null
let StatsigCtor: typeof Statsig | null = null
let StatsigUserCtor: typeof StatsigUser | null = null
let initializing: Promise<void> | null = null

function loadSdk(): void {
  if (StatsigCtor && StatsigUserCtor) return
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@statsig/statsig-node-core') as {
    Statsig: typeof Statsig
    StatsigUser: typeof StatsigUser
  }
  StatsigCtor = mod.Statsig
  StatsigUserCtor = mod.StatsigUser
}

// Initialise Statsig at process boot. No-op when STATSIG_SERVER_SECRET
// is unset, so dev / local runs do not need a real Statsig project.
// Called from `src/server.ts` AFTER `initSentry()` so any Statsig init
// error itself surfaces in Sentry.
export async function initStatsig(): Promise<void> {
  if (client) return
  if (initializing) return initializing
  const secret = process.env.STATSIG_SERVER_SECRET
  if (!secret) {
    log.info('STATSIG_SERVER_SECRET not set; Statsig backend SDK disabled')
    return
  }
  initializing = (async () => {
    try {
      loadSdk()
      const environment =
        process.env.NODE_ENV === 'production' ? 'production' : 'development'
      const c = new StatsigCtor!(secret, { environment })
      await c.initialize()
      client = c
      log.info(`Statsig initialised (environment=${environment})`)
    } catch (err) {
      log.error(
        `Statsig init failed (SDK disabled for this process): ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      initializing = null
    }
  })()
  return initializing
}

// Graceful shutdown: flush buffered events before Railway kills the
// container. Called from the SIGTERM handler in `src/server.ts` next
// to the pg/redis close hooks. Safe when uninitialised (no-op).
export async function shutdownStatsig(): Promise<void> {
  if (!client) return
  try {
    await client.shutdown()
    log.info('Statsig shut down')
  } catch (err) {
    log.warn(
      `Statsig shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    client = null
  }
}

// Build a StatsigUser from a wallet address string. The wallet is the
// primary user identifier across TuCop's backend + wallet + on-chain
// layers, so events keyed on a stable per-user pseudonym still join
// naturally with wallet-side events (wallet applies the same salt to
// its own address before shipping to Statsig).
//
// We push a pseudonym (SHA-256 truncated) into Statsig instead of the
// raw address so third-party PII stores do not carry on-chain-linkable
// identifiers. See lib/pii.ts for the collision + reversal analysis.
function buildUser(walletAddress: string | undefined): StatsigUser {
  const Ctor = StatsigUserCtor!
  const pseudonym = hashWalletAddress(walletAddress)
  if (pseudonym) {
    return new Ctor({
      userID: pseudonym,
      customIDs: { walletPseudonym: pseudonym },
    })
  }
  return new Ctor({ userID: 'anonymous' })
}

// Log a business-critical event to Statsig for backend analytics. Safe
// when the SDK is uninitialised (no-op). Metadata values are coerced to
// strings because Statsig's metadata schema is string-only per the SDK.
export function logStatsigEvent(input: {
  walletAddress?: string
  event: string
  value?: string | number
  metadata?: Record<string, string | number | boolean | null | undefined>
}): void {
  if (!client || !StatsigUserCtor) return
  const user = buildUser(input.walletAddress)
  const metadata: Record<string, string> = {}
  if (input.metadata) {
    for (const [k, v] of Object.entries(input.metadata)) {
      if (v == null) continue
      metadata[k] = String(v)
    }
  }
  try {
    // Statsig's Rust core exposes logEvent as (user, eventName, value?, metadata?).
    // Fire-and-forget; the SDK buffers + batches on its own schedule.
    if (input.value !== undefined) {
      client.logEvent(user, input.event, String(input.value), metadata)
    } else {
      client.logEvent(user, input.event, undefined, metadata)
    }
  } catch (err) {
    // Never let a logging failure propagate to the request handler.
    log.warn(
      `logStatsigEvent(${input.event}) failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// Test-only: reset the process-wide client so a subsequent init in the
// same process rebinds. Also clears the lazy-loaded constructors so a
// fresh SDK load happens (matches init semantics).
export function _resetStatsigForTests(): void {
  client = null
  initializing = null
  StatsigCtor = null
  StatsigUserCtor = null
}
