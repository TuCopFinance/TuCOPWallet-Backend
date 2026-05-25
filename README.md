# TuCOPWallet Backend

Backend services for TuCopWallet. Currently hosts a single endpoint: an Etherscan V2 API proxy used by the mobile app to fetch event logs that the public Celo RPC (Forno) cannot reliably return.

## Endpoints

### `GET /health`

Returns service status.

```json
{ "ok": true, "service": "tucopwallet-backend", "version": "0.1.0" }
```

### `GET /events`

Proxies a contract event-log query to Etherscan V2 API on Celo mainnet (chainid 42220). Only whitelisted contract addresses are accepted (see `ALLOWED_CONTRACTS` in `src/server.ts`).

**Query params:**

| Name | Required | Description |
|------|----------|-------------|
| `address` | yes | Contract address (`0x` + 40 hex). Must be in `ALLOWED_CONTRACTS`. |
| `topic0` | no | Event signature topic. `0x` + 64 hex. |
| `topic1` | no | First indexed argument. `0x` + 64 hex. |
| `fromBlock` | no | Default `0`. |
| `toBlock` | no | Default `latest`. |

**Success response:**

```json
{ "events": [ { "address": "...", "topics": [...], "data": "0x...", ... } ] }
```

**Error responses:**

- `400` `{ "error": "invalid address" }` / `invalid topic0` / `invalid topic1`
- `403` `{ "error": "contract not allowed" }`
- `502` `{ "error": "etherscan error", "detail": "..." }` / `etherscan unreachable`

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

Hosted on Railway in the TuCop Wallet project, environment `production`. Auto-deploys on every push to `main`.

Required Railway env vars:

- `ETHERSCAN_API_KEY` -- Etherscan V2 unified API key (works across all supported chains)
- `PORT` -- injected automatically by Railway

## Adding a new whitelisted contract

Edit `ALLOWED_CONTRACTS` in `src/server.ts`. Use lowercase. Open a PR, merge to `main`, Railway redeploys.
