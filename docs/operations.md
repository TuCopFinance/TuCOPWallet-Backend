# Operations

> Deploy pipeline, environment variables, local development, and operational runbooks. See [`../README.md`](../README.md) for the project overview, [`api.md`](./api.md) for the HTTP endpoint reference, and [`observability.md`](./observability.md) for the metrics + dashboard details.

## Local development

```bash
cp .env.example .env
# Fill in ETHERSCAN_API_KEY from https://etherscan.io/myapikey
yarn install
yarn dev
```

Smoke test:

```bash
curl 'http://localhost:8080/health'
curl 'http://localhost:8080/events?address=0x947c6db1569edc9fd37b017b791ca0f008ab4946&fromBlock=0&toBlock=latest'
```


## Deploy

Hosted on Railway in the TuCop Wallet project, environment `production`. Auto-deploys on every push to `main` via the `.github/workflows/deploy-railway.yml` GitHub Action, which fires after the `CI` workflow succeeds and calls Railway's `serviceInstanceDeployV2` GraphQL mutation with the head SHA. Requires `RAILWAY_API_TOKEN`, `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID` in the repo's GitHub Actions secrets. The Railway-managed GitHub integration is no longer relied on for deploy triggering.

### Rollback

Manual rollback path via `.github/workflows/rollback-railway.yml` (`workflow_dispatch`): GitHub Actions tab -> "Rollback Railway" -> Run workflow. Inputs: `commit_sha` (full or short; must already exist in the repo) and `reason` (one-line audit trail).

The workflow calls the SAME `serviceInstanceDeployV2` mutation as the auto-deploy but with the operator-supplied SHA instead of the latest `main` HEAD. Railway rebuilds from source at that SHA, so this is a true rollback (or roll-forward to an arbitrary committed SHA), not a container snapshot recall. Median end-to-end: same 3-4 min budget as a forward deploy (CI is skipped on this path since the workflow only redeploys an already-built commit).

Use when a bad deploy is live and the standard forward path (revert commit -> merge to main -> auto-deploy) is too slow. For non-emergency reversion prefer the revert-commit path so `main` history reflects the state.

Railway env vars. The annotated source of truth is `.env.example` (every variable carries a REQUIRED / OPTIONAL marker and the behaviour on absence).

### Upstream providers

- `ETHERSCAN_API_KEY` -- required. Etherscan V2 unified API key (works across all supported chains). Backend exits at boot when unset.
- `COINMARKETCAP_API_KEY` -- optional; required for `/api/prices/xaut`. Route returns 502 without it.
- `BLOCKSCOUT_API_KEY` -- optional; injected as `apikey` query param when proxying Blockscout. Some Blockscout instances accept unauth'd reads.
- `BLOCKSCOUT_BASE_URL` -- optional; defaults to `https://celo.blockscout.com`. Must use `https://` AND the hostname must be in the static allowlist in `src/server.ts`.
- `BLOCKSCOUT_ALLOWED_HOSTS` -- optional; comma-separated extra hostnames allowed for `BLOCKSCOUT_BASE_URL`.
- `SQUID_INTEGRATOR_ID` -- required for `/api/swap/quote`. Sent to Squid as the `x-integrator-id` header so revenue attribution lands on TuCop. Local value lives in Keychain (`acct=tucop-finance`, `svce=SQUID_INTEGRATOR_ID`).
- `CORS_WRITE_ALLOWED_ORIGINS` -- optional; comma-separated origins allowed for browser-based POSTs to the write surface. Defaults to `https://tucop.xyz` + localhost variants. When set, REPLACES the defaults.

### Core infra

- `DATABASE_URL` -- optional; required if `INDEXER_ENABLED=true` or `NEERU_INDEXER_ENABLED=true`. Without it the indexers no-op and dependent routes return 503.
- `PG_POOL_MAX` -- optional; pg pool max client count. Default `20`.
- `PG_POOL_CONNECTION_TIMEOUT_MS` -- optional; default `5000`. Request fails fast (-> 503) instead of hanging when the pool is saturated.
- `PG_POOL_IDLE_TIMEOUT_MS` -- optional; default `30000`.
- `REDIS_URL` -- optional; when set, enables caching for price quotes and Blockscout responses, plus persistent WRI rate-limit slot store. Set to the literal string `disabled` to keep the var present but skip Redis entirely. On Railway use `${{Redis.REDIS_PUBLIC_URL}}` (public proxy) or `${{Redis.REDIS_URL}}` (private internal); the client only forces IPv6 lookup for hostnames containing `.railway.internal`, so public proxy URLs keep working.
- `FORNO_URL` -- optional; default `https://forno.celo.org`. Used by the transactions indexer and the WRI relay public client; the Neeru indexer uses this as its Forno fallback entry.
- `PORT` -- injected automatically by Railway. Default `8080`.

### WRI (EIP-7702 delegate relay)

- `WRI_RELAY_PK` -- required for `/api/wri/delegate-relay`. 32-byte hex private key (with `0x` prefix) of the relay hot wallet that pays gas for one-time EIP-7702 delegation setup. Provision via `cast wallet new` and fund with about 10 CELO. Backend logs the derived address at startup so the loaded key is easy to confirm.
- `WRI_RELAY_MIN_CELO_BALANCE` -- optional; minimum relay balance in wei. Default `500000000000000000` (0.5 CELO). Below this the endpoint returns 503.
- `WRI_RELAY_MAX_GAS` -- optional; gas cap (uint256) the relay will commit on a single delegation tx. Default `1000000`.
- `WRI_RELAY_PER_IP_LIMIT` -- optional; per-IP rate limit on the delegate relay (requests per minute). Default `20`. Set to `0` to disable.
- `WRI_RELAY_GLOBAL_LIMIT` -- optional; global token bucket on the delegate relay (requests per minute across ALL addresses + IPs). Default `60`. Requires Redis; fail-closed (returns 503) when Redis is unavailable. Set to `0` to disable.

### Observability

- `SENTRY_DSN` -- optional; when set, uncaught Express errors + manual `captureException` calls are sent to Sentry.
- `SENTRY_TRACES_SAMPLE_RATE` -- optional; default `0.1`. Errors are always captured; this only controls performance traces.

### Transactions indexer

- `INDEXER_ENABLED` -- optional; set to `true` to start the worker at boot. Requires `DATABASE_URL`. Default disabled.

### Neeru indexer (partner contract event ingestion)

- `NEERU_INDEXER_ENABLED` -- optional; set to `true` to start the worker at boot. Requires `DATABASE_URL` + every `NEERU_*` var below. Default disabled.
- `NEERU_INDEXER_INTERVAL_MS` -- optional; worker tick interval. Default `30000`.
- `NEERU_INDEXER_GENESIS_BLOCK` -- required when `NEERU_INDEXER_ENABLED=true`. Block number to start indexing from on first deploy (must match the contract's deployment block).
- `NEERU_CONTRACT_ADDRESS` -- required when `NEERU_INDEXER_ENABLED=true`. Partner contract address (`0x` + 40 hex).
- `NEERU_EVENT_A_TOPIC0`, `NEERU_EVENT_B_TOPIC0`, `NEERU_EVENT_C_TOPIC0`, `NEERU_EVENT_D_TOPIC0` -- required when `NEERU_INDEXER_ENABLED=true`. Four event topic0 hashes the indexer watches (`0x` + 64 hex each).

### Neeru hooks-api / wallet surfaces

- `NEERU_DEPOSIT_TOKEN_ADDRESS` -- required for the Neeru slice of `/hooks-api/*` and `/api/earn/neeru/*`. When unset, the Neeru side is a no-op; Allbridge results still flow through.
- `NEERU_TRANCHE_IMAGE_URL_TEMPLATE` -- optional; template with `{N}` placeholder, e.g. `https://cdn.tucop.xyz/neeru/tranche-{N}.png`.
- `NEERU_MANAGE_URL` -- optional; surface link the wallet shows under "manage your position".
- `NEERU_TERMS_URL` -- optional; surface link the wallet shows under "terms".
- `NEERU_CONTRACT_CREATED_AT_ISO` -- optional; ISO 8601 timestamp the partner contract was deployed. Surfaced in `dataProps.contractCreatedAt`.


## Adding a new whitelisted contract

Edit `ALLOWED_CONTRACTS` in `src/routes/events.ts`. Use lowercase. Open a PR, merge to `main`, Railway redeploys.
