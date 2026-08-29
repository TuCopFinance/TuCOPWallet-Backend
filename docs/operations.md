# Operations

> Deploy pipeline, local development, and operational runbooks. See [`../README.md`](../README.md) for the project overview, [`api.md`](./api.md) for the HTTP endpoint reference, and [`observability.md`](./observability.md) for the metrics + dashboard details.

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

Hosted on Railway. Auto-deploys on every push to `main` via the `.github/workflows/deploy-railway.yml` GitHub Action, which fires after the `CI` workflow succeeds and calls Railway's `serviceInstanceDeployV2` GraphQL mutation with the head SHA. The Railway-managed GitHub integration is no longer relied on for deploy triggering.

### Rollback

Manual rollback path via `.github/workflows/rollback-railway.yml` (`workflow_dispatch`): GitHub Actions tab -> "Rollback Railway" -> Run workflow. Inputs: `commit_sha` (full or short; must already exist in the repo) and `reason` (one-line audit trail).

The workflow calls the SAME `serviceInstanceDeployV2` mutation as the auto-deploy but with the operator-supplied SHA instead of the latest `main` HEAD. Railway rebuilds from source at that SHA, so this is a true rollback (or roll-forward to an arbitrary committed SHA), not a container snapshot recall.

Use when a bad deploy is live and the standard forward path (revert commit -> merge to main -> auto-deploy) is too slow. For non-emergency reversion prefer the revert-commit path so `main` history reflects the state.

## Environment variables

The annotated source of truth is [`.env.example`](../.env.example). Every variable carries a `REQUIRED` / `OPTIONAL` marker and the behaviour on absence. Operational tuning knobs and feature flags are managed via Railway env; they are not documented here to keep the public surface small.

## Adding a new whitelisted contract

Edit `ALLOWED_CONTRACTS` in `src/routes/events.ts`. Use lowercase. Open a PR, merge to `main`, Railway redeploys.
