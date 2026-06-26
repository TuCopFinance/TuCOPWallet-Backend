# TuCOPWallet Backend

Backend services for TuCopWallet. Hosts proxy endpoints used by the mobile app so third-party API keys (Etherscan, CoinMarketCap, Blockscout) never ship in app bundles.

## Cross-cutting behaviour

- **Rate limit:** 300 requests per IP per 60 s window across all endpoints (`express-rate-limit`, in-memory). Sized so an active user firing ~10 swaps in 2-3 minutes (quote refreshes + receipt polling + feed/balance refresh) does not hit the wall; sustained 5 req/s is still considered bot traffic. Exceeding it returns `429 { "error": "rate limit exceeded" }`. Trust-proxy is set to one hop so Railway's LB forwards the real client IP. Per-endpoint tiering is tracked in `ROADMAP.md`.
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
| `quoteOnly` | no | `'true'` or `'false'` | defaults to `'false'`. Set to `'true'` for planning quotes (multi-step `dollarsSpend` flows that fan out 3-5 parallel quotes for the same user); Squid skips the `transactionRequest` build, and per their team this path does NOT charge the wallet-based 10 RPS bucket. Refetch with `quoteOnly=false` (or omit it) on commit, once the user picks a route — that single call IS the one that counts against the bucket. |

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
- `429` `{ "error": "rate limited by squid, retry" }` (pass-through when Squid throttles us; the upstream `Retry-After` header is forwarded). Squid throttles per-wallet at 10 RPS, so the safe pattern for parallel planning quotes is `quoteOnly=true` on the planner and `quoteOnly=false` only on commit.
- `502` `{ "error": "squid upstream unavailable" }` (timeout or non-429 non-2xx from Squid; the upstream message is never echoed)
- `503` `{ "error": "squid integrator id not configured" }` if `SQUID_INTEGRATOR_ID` is not set on the backend

Cached in Redis for 30 s (quotes go stale fast). Cache key includes `userAddress` so we never serve another user's prepared transaction.

### `POST /api/wri/delegate-relay`

One-time, sponsored EIP-7702 delegation setup for TuCop's Wallet Relay Infrastructure (WRI). Most TuCop users hold only stables (USDT, USDC, USDm) and no CELO; this endpoint pays the gas for the single type 0x04 transaction that delegates a user's EOA to TuCop's hardened BatchExecutor at `0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe`. After delegation, every Dolares to Pesos conversion is a normal CIP-64 (type 0x7b) transaction paying gas in stables; CIP-64 and 0x04 are mutually exclusive at the Celo protocol level, hence this dedicated setup tx.

**Request body** (`application/json`):

```json
{
  "userAddress": "0x...",
  "signedAuthorization": {
    "chainId": "0xa4ec",
    "address": "0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe",
    "nonce": "0x...",
    "yParity": "0x0",
    "r": "0x...",
    "s": "0x..."
  }
}
```

`signedAuthorization` is the JSON shape viem's `walletClient.signAuthorization(...)` emits.

**Security invariants (any failure -> 400, no tx submitted):**

- `userAddress` must match `0x` + 40 hex.
- `signedAuthorization.chainId` must be `42220` (Celo mainnet only).
- `signedAuthorization.address` must equal `0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe` (case-insensitive). The relay refuses to delegate to any other contract, period. Hardcoded.
- `signedAuthorization.nonce` must equal the on-chain nonce of `userAddress` plus or minus 1.
- The signature must recover to `userAddress` via `recoverAuthorizationAddress`.

**Operational invariants:**

- If the user's EOA code already starts with `0xef0100` followed by the BatchExecutor address, the endpoint short-circuits with `{ "status": "already_delegated" }` and submits no tx.
- Per-address rate limit: 1 successful relay per 5 minutes per `userAddress` (Redis-backed when `REDIS_URL` is configured, in-process Map otherwise; without Redis the limit is per-instance only).
- Relay hot-wallet health check: if balance is below `WRI_RELAY_MIN_CELO_BALANCE`, returns 503 and logs an alert.
- The global 120 req/min/IP rate limit from `app.ts` still applies on top.

**Success response (delegation submitted and confirmed):**

```json
{
  "status": "delegated",
  "txHash": "0x...",
  "userAddress": "0x...",
  "delegatedTo": "0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe"
}
```

**Error responses:**

- `400` `{ "error": "invalid userAddress" }` / `invalid signedAuthorization` / `invalid chainId` / `invalid delegation target` / `invalid signature` / `nonce mismatch`
- `429` `{ "error": "address rate limited" }` with `Retry-After` header
- `502` `{ "error": "rpc unavailable" }` / `relay tx submission failed` / `relay tx reverted` / `relay tx unconfirmed` / `relay tx unverified`
- `503` `{ "error": "relay temporarily unavailable" }` (relay private key missing/invalid or balance below threshold)

**Out of scope:** this endpoint ONLY handles the one-time delegation setup. The actual `execute(calls)` payload that uses the delegated EOA must be sent by the wallet as a regular CIP-64 transaction; the backend does not relay batch payloads.

### Transaction feed (WRI Track C)

Backend-owned replacement for Valora's `getWalletTransactions`. Indexes Celo blocks for opted-in addresses and classifies into the same `TokenTransaction` shape the wallet already consumes, with an extension for EIP-7702 atomic batches (which Valora omits).

**Required env to enable on Railway:** `DATABASE_URL` (Postgres; migrations run on boot) and `INDEXER_ENABLED=true`. Without these the routes return `503` and the indexer loop is a no-op.

#### `POST /api/transactions/watch`

Registers an address for indexing. Called by the wallet at boot after `walletAddressInitialized`. Idempotent, safe to retry, the wallet should not block on its result.

```json
{ "address": "0x..." }
```

Response `200`: `{ "ok": true, "backfillStartedAt": null }`. The `backfillStartedAt` field will become an ISO8601 string when the backfill job (future PR) is implemented; today the indexer only catches the forward path.

Errors: `400 invalid address`, `503 database not configured`, `500 database error`.

#### `GET /api/transactions/feed`

Byte-compatible replacement for Valora. Same response envelope (`{ transactions, pageInfo: { hasNextPage, endCursor } }`) and same `TokenTransaction` discriminated union (`SENT` / `RECEIVED` / `SWAP_TRANSACTION` / `APPROVAL`).

**Query params:**

| Name | Required | Notes |
|------|----------|-------|
| `address` | yes | `0x` + 40 hex (case-insensitive) |
| `networkIds` | no | csv, defaults to `celo-mainnet` |
| `includeTypes` | no | csv of `TokenTransaction` types, filter applied post-classification |
| `localCurrencyCode` | no | reserved for future price conversion; today `localAmount` is always `null` |
| `afterCursor` | no | opaque cursor returned by a previous page |
| `pageSize` | no | 1 to 100, default 20 |

**7702 atomic-batch extension:** when one tx atomically sells more than one token, the wallet receives a single `SwapTransaction` whose `fromTokenAmounts[]` lists every sold token; `outAmount` is the highest-value leg so existing single-leg renderers keep working unchanged. `inAmount` is the bought token. The selector keyed off is `0x3f707e6b` (`execute((address,uint256,bytes)[])` on the BatchExecutor at `0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe`).

**Token IDs:** ERC20s are emitted as `celo-mainnet:0x<contract>`. CELO native is emitted as its ERC20 contract id `celo-mainnet:0x471ece3750da237f93b8e339c536989b8978a438`, not a `:native` sentinel, so the wallet's token registry resolves it the same way as any other ERC20.

Errors: `400 invalid address` / `invalid afterCursor`, `503 database not configured`, `500 database error`.

#### Provisioning the relay hot wallet (one-time, before enabling on Railway)

1. Generate a throwaway key. Example with foundry:

   ```bash
   cast wallet new
   # Address: 0x...
   # Private key: 0x...
   ```

2. Fund the address with around 10 CELO (this covers thousands of delegation setups). Top up when balance approaches `WRI_RELAY_MIN_CELO_BALANCE`.
3. On Railway, set `WRI_RELAY_PK` to the private key (with the `0x` prefix). The backend logs the derived address at startup so you can confirm the right key was loaded.

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
- `WRI_RELAY_PK` -- required for `/api/wri/delegate-relay`. 32-byte hex private key (with `0x` prefix) of the relay hot wallet that pays gas for one-time EIP-7702 delegation setup. Provision via `cast wallet new` and fund with about 10 CELO. The backend logs the derived address at startup so the correct key is easy to confirm.
- `WRI_RELAY_MIN_CELO_BALANCE` -- optional; minimum relay balance in wei. Default `500000000000000000` (0.5 CELO). Below this the endpoint returns 503.
- `WRI_RELAY_MAX_GAS` -- optional; gas cap (uint256) the relay will commit on a single delegation tx. Default `1000000`.
- `PORT` -- injected automatically by Railway

## Adding a new whitelisted contract

Edit `ALLOWED_CONTRACTS` in `src/routes/events.ts`. Use lowercase. Open a PR, merge to `main`, Railway redeploys.
