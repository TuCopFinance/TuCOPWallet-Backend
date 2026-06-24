# TuCOPWallet Backend

Backend services for TuCopWallet. Hosts proxy endpoints used by the mobile app so third-party API keys (Etherscan, CoinMarketCap, Blockscout) never ship in app bundles.

## Cross-cutting behaviour

- **Rate limit:** 120 requests per IP per 60 s window across all endpoints (`express-rate-limit`, in-memory). Exceeding it returns `429 { "error": "rate limit exceeded" }`. Trust-proxy is set to one hop so Railway's LB forwards the real client IP.
- **Upstream timeout:** every outbound call (Etherscan, CoinMarketCap, Blockscout) is wrapped in `fetchWithTimeout` with an 8 s default, so a hung upstream never holds an inbound request open indefinitely.
- **Cache fallthrough:** when `REDIS_URL` is unset or set to the literal `disabled`, every request goes direct to upstream. Otherwise the cache is consulted with normalised keys; failed cache reads or writes fall through and never break the response.
- **Logging:** all diagnostic output goes through `src/lib/logger.ts` with per-module namespaces (e.g. `[app:req]`, `[routes:blockscout]`). In production (`NODE_ENV=production`) only `warn` and `error` are emitted.

## Endpoints

### `GET /health`

Returns service status.

```json
{ "ok": true, "service": "tucopwallet-backend", "version": "0.1.0" }
```

### `GET /api/prices/xaut`

Proxies a XAUt0 price quote (in USD) from CoinMarketCap. Cached in Redis for 60 seconds when `REDIS_URL` is configured; serves direct otherwise.

**Query params:**

| Name | Required | Description |
|------|----------|-------------|
| `vs` | no | Quote currency. Only `usd` is supported. Defaults to `usd`. |

**Success response:**

```json
{ "symbol": "XAUT", "vs": "usd", "priceUsd": 3421.5, "asOf": "2026-06-16T12:00:00.000Z" }
```

**Error responses:**

- `400` `{ "error": "only vs=usd supported" }`
- `502` `{ "error": "upstream price feed unavailable" }`

### `GET /events`

Proxies a contract event-log query to Etherscan V2 API on Celo mainnet (chainid 42220). Only whitelisted contract addresses are accepted (see `ALLOWED_CONTRACTS` in `src/app.ts`).

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
- `502` `{ "error": "etherscan error" }` / `etherscan unreachable` (upstream message is logged server-side, never returned)
- `503` `{ "error": "etherscan key not configured" }`

### Blockscout proxy

Passthrough proxy for Celo's Blockscout V2 API, injecting the API key on the server side so the mobile app never sees it. Responses are returned exactly as Blockscout returns them.

| Endpoint | Cache TTL |
|----------|-----------|
| `GET /api/v2/transactions/:hash` | 30 s |
| `GET /api/v2/addresses/:address/transactions` | 30 s |
| `GET /api/v2/addresses/:address/token-transfers` | 300 s |

Query string parameters (e.g. `filter`, `block_number`) are forwarded to upstream. The reserved `apikey` and `api_key` keys are stripped server-side so clients cannot override the server key. Cache keys are normalised (sorted, reserved params dropped, capped at 512 chars) so callers cannot blow up the Redis keyspace by passing junk params.

Validation: `:hash` must match `0x` + 64 hex; `:address` must match `0x` + 40 hex. Otherwise `400 { "error": "invalid ..." }`. Upstream failures return `502 { "error": "blockscout upstream unavailable" }`.

### `GET /api/swap/quote`

Drop-in replacement for Valora's `getSwapQuote` cloud function. Backend POSTs to Squid Router v2 with TuCop's `x-integrator-id` so swap volume attribution flows to TuCop. The response shape matches the wallet's `FetchQuoteResponse` (`src/swap/types.ts` in TuCopWallet) so the mobile-side change is a single URL flip.

**Query params (strict allowlist; any other key returns `400 { "error": "unknown param: <name>" }`):**

| Name | Required | Validation | Notes |
|------|----------|------------|-------|
| `buyToken` | yes | `0x` + 40 lowercase hex | destination token |
| `buyIsNative` | yes | `'true'` or `'false'` | substitutes the EVM native sentinel upstream |
| `buyNetworkId` | yes | matches `/^[a-z0-9-]+$/` | e.g. `celo-mainnet`, `ethereum-mainnet`, `arbitrum-one`, `op-mainnet`, `polygon-pos-mainnet`, `base-mainnet` |
| `sellToken` | yes | `0x` + 40 lowercase hex | source token |
| `sellIsNative` | yes | `'true'` or `'false'` | |
| `sellNetworkId` | yes | same set as `buyNetworkId` | |
| `sellAmount` | yes | decimal integer (smallest unit / wei) | |
| `userAddress` | yes | `0x` + 40 lowercase hex | EOA used for `fromAddress` and `toAddress` upstream |
| `slippagePercentage` | no | decimal in `[0, 100]` | defaults to `0.5` |

**Success response (shape):**

```json
{
  "unvalidatedSwapTransaction": {
    "swapType": "same-chain",
    "chainId": 42220,
    "buyAmount": "998000",
    "sellAmount": "1000000",
    "buyTokenAddress": "0x...",
    "sellTokenAddress": "0x...",
    "price": "0.998",
    "guaranteedPrice": "0.993",
    "estimatedPriceImpact": "0.2",
    "gas": "300000",
    "estimatedGasUse": "200000",
    "to": "0x...",
    "value": "0",
    "data": "0x...",
    "from": "0x...",
    "allowanceTarget": "0x..."
  },
  "details": { "swapProvider": "squid" }
}
```

When `sellNetworkId !== buyNetworkId`, the `unvalidatedSwapTransaction` object additionally has `swapType: "cross-chain"` plus `estimatedDuration` (seconds), `maxCrossChainFee` and `estimatedCrossChainFee` (wei strings, sum of upstream `feeCosts`).

**Error responses:**

- `400` `{ "error": "invalid <field>" }` / `{ "error": "unknown param: <name>" }` / `{ "error": "unsupported sellNetworkId: <slug>" }`
- `429` `{ "error": "rate limited by squid, retry" }` (pass-through when Squid throttles us; the upstream `Retry-After` header is forwarded so the wallet's retry hook can back off correctly)
- `502` `{ "error": "squid upstream unavailable" }` (timeout or non-429 non-2xx from Squid; the upstream message is never echoed)
- `503` `{ "error": "squid integrator id not configured" }` if `SQUID_INTEGRATOR_ID` is not set on the backend

Cached in Redis for 30 s (quotes go stale fast). Cache key includes `userAddress` so we never serve another user's prepared transaction.

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
- `COINMARKETCAP_API_KEY` -- CoinMarketCap Pro API key, needed by `/api/prices/xaut`
- `BLOCKSCOUT_API_KEY` -- optional; injected as `apikey` query param when proxying Blockscout
- `BLOCKSCOUT_BASE_URL` -- optional; defaults to `https://celo.blockscout.com`
- `SQUID_INTEGRATOR_ID` -- required for `/api/swap/quote`. Sent to Squid as the `x-integrator-id` header so revenue attribution lands on TuCop. Local value lives in Keychain (`acct=tucop-finance`, `svce=SQUID_INTEGRATOR_ID`).
- `REDIS_URL` -- optional; when set, enables caching for price quotes and Blockscout responses. Set to the literal string `disabled` to keep the var present but skip Redis entirely. On Railway use `${{Redis.REDIS_PUBLIC_URL}}` (public proxy) or `${{Redis.REDIS_URL}}` (private internal); the client only forces IPv6 lookup for hostnames containing `.railway.internal`, so public proxy URLs keep working.
- `PORT` -- injected automatically by Railway

## Adding a new whitelisted contract

Edit `ALLOWED_CONTRACTS` in `src/server.ts`. Use lowercase. Open a PR, merge to `main`, Railway redeploys.
