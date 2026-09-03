# Observability runbook

How to wire alerting + dashboards for TuCopWallet-Backend in production. Pairs with the in-code instrumentation from Fase 2 PR 11 (`/metrics`, `/ready`, `/health/relay`) and Fase 2 PR 10 (Sentry).

This file is operational, not code. Follow it once per environment.

## Stack

| Concern | Tool | Tier | Why |
|---|---|---|---|
| Errors / exceptions | Sentry | Free (5k events/month) | Captures uncaught + manual `captureException` with stack + request context |
| Metrics + dashboards + alerts | Grafana Cloud | Free (10k active series, 14-day retention) | Scrapes `/metrics`, alerts via contact points |
| Logs | Railway built-in | Included | Streamed from process stdout via `lib/logger` |

## Sentry (errors)

Already wired in code by Fase 2 PR 10. Operator action:

1. Create a Sentry project at `sentry.io` (Node.js platform).
2. Copy the DSN. Set `SENTRY_DSN` in Railway env. Optional: `SENTRY_TRACES_SAMPLE_RATE` (default `0.1`).
3. In Sentry: configure issue alerts. Suggested rule: "Notify Slack/Telegram on first occurrence of any new issue".

## Grafana Cloud (metrics + alerts)

### Step 1: provision the scrape

Grafana Cloud free tier includes a hosted Prometheus + scrape agents. Two ways to scrape:

**Option A: Grafana Agent on Railway as a separate service** (recommended for a single-instance backend).

```yaml
# grafana-agent.yaml (paste into a sibling Railway service)
metrics:
  global:
    scrape_interval: 30s
  configs:
    - name: tucop-backend
      remote_write:
        - url: https://prometheus-prod-XX-prod-XX-XXXXX.grafana.net/api/prom/push
          basic_auth:
            username: YOUR_INSTANCE_ID
            password: YOUR_GRAFANA_API_TOKEN
      scrape_configs:
        - job_name: backend
          static_configs:
            - targets: ['tucop-backend-production.up.railway.app:443']
              labels:
                env: production
          scheme: https
          metrics_path: /metrics
```

**Option B: Prometheus Pushgateway** (simpler for proof-of-concept). Add a `setInterval(60_000, () => push(/metrics))` from inside the backend process to a pushgateway URL. Not recommended for prod because the gateway is a per-instance singleton; metrics aren't scraped, they're pushed at intervals.

### Step 2: dashboards

Import the following PromQL panels into a new Grafana dashboard (one per row):

| Panel | Query |
|---|---|
| Requests/sec | `sum by (route) (rate(http_request_duration_seconds_count[5m]))` |
| p95 latency | `histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))` |
| Error rate | `sum by (route) (rate(http_request_duration_seconds_count{status=~"5.."}[5m])) / sum by (route) (rate(http_request_duration_seconds_count[5m]))` |
| Relay balance | `wri_relay_balance_celo` |
| pg pool saturation | `pg_pool_waiting` |
| pg pool size | `pg_pool_total - pg_pool_idle` |

### Step 3: alert rules

Wire alert rules against the metrics catalogued above. Tune thresholds against real prod traffic after one week.

Metric families that carry live-alert value:

- Relay hot-wallet balance (`wri_relay_balance_celo` + `wri_relay_balance_last_updated_seconds`).
- Backend availability (`up{job="backend"}` absence).
- Error rate (`http_request_duration_seconds_count{status=~"5.."}` rate).
- pg pool saturation (`pg_pool_waiting`).
- WRI relay rate-limit budget consumption (`wri_relay_rate_limited_total{tier=...}` rate).
- Indexer lag (`transactions_indexer_lag_blocks` + `neeru_indexer_lag_blocks`).

Concrete alert expressions, thresholds, severities, and paging channels are maintained in operator-owned Grafana Cloud config, not published here (public-repo sensitivity gate: publishing exact tripping values tells an attacker where the defensive perimeters sit).

Contact points: configure Slack webhook OR Telegram bot in Grafana Cloud's notification settings.

## Railway healthcheck

After Fase 2 PR 11 lands, repoint Railway's HTTP healthcheck from `/health` to `/ready`:

1. Railway dashboard -> Settings -> Health Check
2. Path: `/ready` (was `/health`)
3. Timeout: 5s (was default)

This ensures Railway restarts a pod that has a dead Postgres / RPC dependency instead of leaving it serving 5xx.

## Verification

Once the scrape is live:

1. `curl https://tucop-backend-production.up.railway.app/metrics | grep wri_relay_balance` -> should return the live balance.
2. In Grafana Explore: query `wri_relay_balance_celo` -> should see data points every 30s.
3. Fire-drill the alert path by temporarily lowering a threshold, waiting for the alert to trip in Slack/Telegram, then restoring. Operator-facing detail lives in the internal alerts config, not published here.

## What this runbook is NOT for

- Sentry source-map upload (Railway build doesn't currently emit them; deferred).
- Indexer-specific metrics (`neeru_indexer_blocks_lagged`, etc.). Deferred to Fase 3 alongside indexer supervisor tests.
- OpenTelemetry distributed traces. Single-instance / no microservices today; revisit at scale.
