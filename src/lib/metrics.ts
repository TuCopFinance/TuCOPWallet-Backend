import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'
import { getDb } from './db'
import { getRelayClients } from './wriRelay'

// Single registry so the `/metrics` handler emits one consistent dump.
// Default node/process metrics (event loop lag, GC pauses, heap, cpu) are
// included via collectDefaultMetrics; everything custom is registered here.
export const metricsRegistry = new Registry()

metricsRegistry.setDefaultLabels({ service: 'tucopwallet-backend' })
collectDefaultMetrics({ register: metricsRegistry })

// HTTP request duration histogram. Labels: method, route (the Express route
// template, not the raw URL with IDs), status code.
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  // Buckets tuned for the proxy / RPC mix: most cache hits < 100ms, RPC
  // calls 200-2000ms, WRI relay including receipt wait up to 30s.
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
})

// WRI relay rate-limit counters. Labels: tier (per-ip, global, per-address).
// Used by Grafana alerts to detect attacks and bucket exhaustion.
export const wriRelayRateLimitedTotal = new Counter({
  name: 'wri_relay_rate_limited_total',
  help: 'Total /api/wri/delegate-relay requests rejected by a rate-limit tier',
  labelNames: ['tier'],
  registers: [metricsRegistry],
})

// WRI relay tx submission counters. Labels: outcome (delegated,
// already_delegated, reverted, unconfirmed, submission_failed).
export const wriRelayTxOutcomeTotal = new Counter({
  name: 'wri_relay_tx_outcome_total',
  help: 'Total /api/wri/delegate-relay tx submission outcomes',
  labelNames: ['outcome'],
  registers: [metricsRegistry],
})

// pg pool gauges. Scraped on every /metrics request from the live pool stats.
new Gauge({
  name: 'pg_pool_total',
  help: 'Total clients in the pg pool (idle + checked out)',
  registers: [metricsRegistry],
  collect() {
    const db = getDb()
    this.set(db?.totalCount ?? 0)
  },
})

new Gauge({
  name: 'pg_pool_idle',
  help: 'Idle clients in the pg pool',
  registers: [metricsRegistry],
  collect() {
    const db = getDb()
    this.set(db?.idleCount ?? 0)
  },
})

new Gauge({
  name: 'pg_pool_waiting',
  help: 'Requests waiting for a pg pool client (saturation indicator)',
  registers: [metricsRegistry],
  collect() {
    const db = getDb()
    this.set(db?.waitingCount ?? 0)
  },
})

// Backfill counters + gauges. Emitted by the backfill loop after every
// chunk transaction. `outcome=ok` = chunk fully persisted + cursor advanced;
// `rpc_error` = every fallback endpoint failed for this chunk (retry on the
// next iteration with backoff); `persist_error` = at least one tx in the
// chunk failed the local DB write (the successful ones DO land + cursor
// still advances).
export const transactionsIndexerBackfillChunksTotal = new Counter({
  name: 'transactions_indexer_backfill_chunks_total',
  help: 'Backfill chunks processed by outcome',
  labelNames: ['outcome'],
  registers: [metricsRegistry],
})

// How many /watch backfills are running right now. Non-persistent - resets on
// process restart; the boot-time resume path re-populates it as it kicks off
// resumed jobs.
export const transactionsIndexerBackfillActiveJobs = new Gauge({
  name: 'transactions_indexer_backfill_active_jobs',
  help: 'Number of backfill loops currently executing',
  registers: [metricsRegistry],
})

// Total blocks remaining to scan across ALL in-progress backfills. Grafana
// can chart this against wall-clock to estimate ETA.
export const transactionsIndexerBackfillBlocksRemaining = new Gauge({
  name: 'transactions_indexer_backfill_blocks_remaining',
  help: 'Sum of (backfill_end_block - backfill_cursor_block) across in-progress backfills',
  registers: [metricsRegistry],
})

// Transactions indexer lag in blocks (celo tip - last indexed block). Updated
// by the worker on every successful tick AND by the indexer health route.
// Grafana alerts when this stays > 20 for >2 min (per WRI Track C plan AC #3).
export const transactionsIndexerLagBlocks = new Gauge({
  name: 'transactions_indexer_lag_blocks',
  help: 'Celo tip block minus last indexed block. Stays at 0 when the indexer is caught up.',
  labelNames: ['network_id'],
  registers: [metricsRegistry],
})

// Total addresses the transactions indexer is watching. Quick sanity check
// that POST /api/transactions/watch is reaching the DB. Updated alongside
// the lag gauge.
export const transactionsIndexerWatchedAddresses = new Gauge({
  name: 'transactions_indexer_watched_addresses',
  help: 'Number of addresses registered via POST /api/transactions/watch',
  labelNames: ['network_id'],
  registers: [metricsRegistry],
})

// WRI relay balance gauge. Scraped on /metrics request via an RPC call.
// Async collect is supported via a sync gauge that stores the last-known
// value; we update it inside an async helper triggered by the /metrics route
// handler so prom-client's sync `register.metrics()` returns a stable value.
const wriRelayBalanceCelo = new Gauge({
  name: 'wri_relay_balance_celo',
  help: 'Current relay hot-wallet balance in CELO',
  registers: [metricsRegistry],
})

const wriRelayBalanceLastUpdated = new Gauge({
  name: 'wri_relay_balance_last_updated_seconds',
  help: 'Unix timestamp of the last successful relay balance scrape',
  registers: [metricsRegistry],
})

// Refreshed by /metrics handler. Keeps state across scrapes so failure to
// fetch doesn't blank the gauge (which would alert as a false "balance=0").
export async function refreshRelayBalanceMetric(): Promise<void> {
  const relay = getRelayClients()
  if (!relay) return
  try {
    const balanceWei = await relay.publicClient.getBalance({
      address: relay.account.address,
    })
    // CELO is 18 decimals. Convert to a float for the gauge.
    const celo = Number(balanceWei) / 1e18
    wriRelayBalanceCelo.set(celo)
    wriRelayBalanceLastUpdated.set(Math.floor(Date.now() / 1000))
  } catch {
    // Leave the previous value in place. Alert on
    // wri_relay_balance_last_updated_seconds staleness instead of relying on
    // the balance value alone.
  }
}
