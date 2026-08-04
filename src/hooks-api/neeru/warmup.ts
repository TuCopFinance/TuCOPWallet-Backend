import type { Pool } from 'pg'
import type { NeeruIndexerRpcClient } from '../../neeru-indexer/rpc'
import { createLogger } from '../../lib/logger'
import { getNeeruEarnPositions } from './positions'

const log = createLogger('hooks-api:neeru:warmup')

// Default interval keeps DB pool + catalogue cache + RPC HTTP client warm
// well within the shortest resource timeout: pg pool idleTimeoutMillis is
// 30s (see src/lib/db.ts), catalogue cache TTL is 30s (positions.ts). A
// 20s tick guarantees at least one warm-touch per idle window so no
// external request has to pay the cold reconnect / multicall cost on the
// hot path.
const DEFAULT_WARMUP_INTERVAL_MS = 20_000

export interface StartNeeruWarmupArgs {
  db: Pool
  rpc: NeeruIndexerRpcClient
  intervalMs?: number
  // Optional AbortSignal so server.ts can stop the interval on SIGTERM /
  // SIGINT alongside the indexers. When omitted the warmup runs for the
  // lifetime of the process.
  signal?: AbortSignal
}

export interface WarmupHandle {
  // Exposed for tests. In production the interval is left running for the
  // process lifetime (or cancelled via the AbortSignal).
  stop: () => void
}

// Fires an internal tick every intervalMs. Each tick:
//   1. runs `SELECT 1` on the pg pool so at least one connection stays
//      out of the idle-timeout queue.
//   2. calls getNeeruEarnPositions without an address, which refreshes
//      the process-local catalogue cache + exercises the neeru RPC HTTP
//      client (TLS + keepalive stay warm).
// Errors are logged and swallowed so a transient upstream failure does
// not crash the process.
export function startNeeruWarmup(args: StartNeeruWarmupArgs): WarmupHandle {
  const intervalMs = args.intervalMs ?? DEFAULT_WARMUP_INTERVAL_MS
  let stopped = false

  async function tick(): Promise<void> {
    if (stopped) return
    try {
      await args.db.query('SELECT 1')
    } catch (err) {
      log.warn(
        `db keepalive failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (stopped) return
    try {
      await getNeeruEarnPositions({ db: args.db, rpc: args.rpc })
    } catch (err) {
      log.warn(
        `catalogue prefetch failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Fire once immediately so the FIRST hit after cold boot / redeploy
  // does not pay the cost. Subsequent ticks maintain warmth.
  void tick()

  const handle = setInterval(() => {
    void tick()
  }, intervalMs)

  const stop = (): void => {
    stopped = true
    clearInterval(handle)
  }

  if (args.signal) {
    if (args.signal.aborted) {
      stop()
    } else {
      args.signal.addEventListener('abort', stop, { once: true })
    }
  }

  return { stop }
}
