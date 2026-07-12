# TuCop Wallet <-> Backend integration spec

> Source of truth for the wallet team on how to consume `tucop-backend-production.up.railway.app`. Every endpoint, every kill switch, every failure mode, every wire contract, every backend-owned config knob that changes wallet behavior.
>
> **Owner:** TuCop backend team. **Contact:** open a PR against this file. **Cadence:** any wire change on the backend must land alongside a diff to this file in the same PR. If it does not, the wire change is not shipped.

## Table of contents

1. [Environment + base URLs](#environment--base-urls)
2. [Version + deploy chain](#version--deploy-chain)
3. [Public HTTP endpoints](#public-http-endpoints)
   1. [Health probes](#1-health-probes)
   2. [Blockscout proxy](#2-blockscout-proxy)
   3. [Prices](#3-prices)
   4. [Squid quote proxy](#4-squid-quote-proxy)
   5. [WRI delegate-relay](#5-wri-delegate-relay)
   6. [WRI fee-adapter bootstrap](#6-wri-fee-adapter-bootstrap)
   7. [Transactions indexer (feed / watch)](#7-transactions-indexer-feed--watch)
   8. [Hooks API v2](#8-hooks-api-v2)
   9. [Neeru positions detail](#9-neeru-positions-detail)
   10. [Events proxy](#10-events-proxy)
4. [Backend kill switches (env-driven)](#backend-kill-switches-env-driven)
5. [Error contract](#error-contract)
6. [Zero-exposure bar (symmetric)](#zero-exposure-bar-symmetric)
7. [Rate limits](#rate-limits)
8. [Caching + TTLs](#caching--ttls)
9. [Verification playbook](#verification-playbook)
10. [Escalation](#escalation)

---

## Environment + base URLs

The wallet talks to five Railway services under the `TuCopFinance` org. Only one, `tucop-backend`, is scoped by this spec. The other four are documented for orientation.

| Purpose | Base URL | Repo | This spec covers? |
|---|---|---|---|
| Feed indexer, hooks-api, Neeru, WRI, Blockscout proxy, prices, Squid quotes | `https://tucop-backend-production.up.railway.app` | `TuCopFinance/TuCOPWallet-Backend` | yes |
| Phone verification, wallet linking, OTP | `https://api-wallet-tucop-production.up.railway.app` | separate | no |
| Keyless backup, SIWE, Twilio proxy | `https://twilio-service.up.railway.app` | separate | no |
| BucksPay offramp proxy | `https://buckspay-webhook-production-ad81.up.railway.app` | separate | no |

`api-wallet-tucop`, `twilio-service`, and `buckspay-webhook` are documented in their own repos.

All examples below use `https://tucop-backend-production.up.railway.app` as the base; abbreviated as `BASE` in code fences.

## Version + deploy chain

- **Branch layout.** `main` is what runs in production. `development` is the integration branch. Every backend change lands as a PR to `development`, then a release PR merges `development` -> `main`. Deploys trigger on any push to `main`. No feature branch pushes direct to `main`.
- **Wire changes require a spec update in the same PR.** If a PR touches any file under `src/routes/`, `src/hooks-api/`, `src/transactions-indexer/`, or `src/lib/env.ts` (kill switches or env-driven wire config), the same PR MUST diff this file. Backend CI does not enforce this yet; it's a social rule.
- **Deploy verification.** Every release PR to `main` includes a smoke-test checklist against the endpoints below. If a hotfix is needed, it goes through `development` -> `main` too (see 2026-07-12 selector-bug incident as the recent case).

## Public HTTP endpoints

### 1. Health probes

Three read-only probes for wallet-side telemetry + oncall dashboards.

`GET /health` (liveness):
```
200 { "ok": true, "service": "tucopwallet-backend", "version": "0.1.0" }
```

`GET /ready` (readiness with dependency checks):
```
200 { "ok": true, "checks": { "db": "ok", "redis": "ok"|"disabled", ... } }
503 { "ok": false, "checks": { ... }, "failing": ["db"] }
```

`GET /health/relay` (WRI relay hot-wallet balance):
```
200 { "ok": true, "address": "0x...", "balanceWei": "...", "minWei": "..." }
503 { "ok": false, "reason": "below_min_balance" | "not_configured" }
```

Wallet-side use: `/ready` should be polled by any observability integration you have; if it 503s for >5 minutes, page the backend oncall. `/health/relay` failing means all WRI 7702 flows will 412 until relay is refunded (currently manual).

`GET /metrics` returns Prometheus text; wallet does not need to consume.

### 2. Blockscout proxy

Read-only proxy to Blockscout's API with the wallet's Blockscout Pro key attached server-side. Reserved query params (`apikey`, `api_key`) are stripped before forward so callers cannot override.

```
GET  BASE/api/v2/transactions/:hash
GET  BASE/api/v2/addresses/:address/transactions
GET  BASE/api/v2/addresses/:address/token-transfers
```

Passes through Blockscout's response shape. Redis-cached (`Redis.REDIS_PUBLIC_URL` in `REDIS_URL`) for 30s per key; cache keys built via sorted-query normalization (`src/lib/query.ts`), reserved params dropped, capped at 512 chars.

Timeouts: 8s (`fetchWithTimeout`). On timeout: 502 `{ "error": "blockscout error" }`. Upstream error body never echoed.

### 3. Prices

```
GET  BASE/api/prices/xaut
```

Returns CoinMarketCap's spot price for XAUt via server-side API key. Redis-cached 60s. Response: `{ "priceUsd": "<numeric>" }`.

### 4. Squid quote proxy

```
GET  BASE/api/swap/quote?fromChain=...&fromToken=...&toChain=...&toToken=...&fromAmount=...&fromAddress=...&toAddress=...&slippage=...
```

Proxies Squid's quote endpoint with the backend's `SQUID_INTEGRATOR_ID`. Passes 429 through directly if Squid rate-limits (per-wallet 10 RPS at Squid). Wallet-side pattern: debounce + dedupe on wallet address so you don't hit the 10 RPS ceiling. This is documented in the backend memory `squid_quote_proxy.md`.

Response: Squid's quote payload verbatim.

### 5. WRI delegate-relay

```
POST BASE/api/wri/delegate-relay
```

Sponsors the 7702 delegate authorization. Body: `{ address, authorization }`. Returns `{ txHash }` on success. Rate-limited per-IP (`WRI_RELAY_PER_IP_LIMIT`, default 20) and globally (`WRI_RELAY_GLOBAL_LIMIT`, default 60). Kill switch: `WRI_RELAY_PK` unset -> 503 `{ "error": "relay temporarily unavailable" }`.

### 6. WRI fee-adapter bootstrap

Sponsors `approve(adapter, MAX_UINT256)` on every adapter-only token the user holds (USDC, USDT). Solves the chicken-and-egg where the user cannot pay gas in a fee-abstracted token until they've granted the adapter allowance.

```
POST BASE/api/wri/fee-adapter-bootstrap
Body: { "address": "0x..." }
```

Response semantics:
- `200 { "ok": true, "results": TokenResult[], "relayAddress": "0x..." }`
- `TokenResult = { symbol, tokenAddress, adapterAddress, status }` where `status ∈ { "sponsored", "already_allowed", "skipped_no_adapter", "skipped_no_balance" }`.
- `400 { "error": "invalid address" }`
- `412 { "error": "precondition failed: user not delegated to BatchExecutor" }` — user has not delegated yet, wallet must run the 7702 delegate flow first.
- `503 { "error": "fee bootstrap disabled" }` — kill switch off.
- `503 { "error": "relay temporarily unavailable" }` — relay client unavailable.
- `503 { "error": "no adapter tokens configured (set WRI_FEE_ADAPTER_*)" }` — no `WRI_FEE_ADAPTER_*` env is set. Operator issue.
- `500 { "error": "internal" }` — bootstrap threw; check backend logs.

**Wire contract:** the endpoint takes ONLY `address`. There is no `adapter` param. Backend iterates over all `WRI_FEE_ADAPTER_*` env vars and processes each token. If you want to sponsor only one token, that's an env config change, not a request change.

**Wallet-side detection pattern:** any RPC error containing "412" or a decoded `delegate-relay-required` should chain into this endpoint's call before retrying the original tx. `src/wri/feeAdapterBootstrap/api.ts:105` checks `response.status === 412`, not string-match; safe against future body text changes.

**Kill switch:** `WRI_FEE_BOOTSTRAP_ENABLED` (env, per-request evaluated). Set to `"true"` to enable, `"false"` or unset to gate. Currently `true`.

### 7. Transactions indexer (feed / watch)

Wallet's on-chain transaction feed. Backfills historical, follows the tip, indexes multi-leg 7702 batches.

`POST BASE/api/transactions/watch`:
```
Body: { "address": "0x...", "walletCreatedAt": "<ISO8601>", "networkIds": ["celo-mainnet"] }
Response: 200 { "ok": true, "backfillCompleted": true|false }
        | 400 { "error": "invalid address" | "invalid walletCreatedAt" | "unsupported networkId" }
        | 503 { "error": "watch disabled" }
```

Idempotent: repeated calls with the same `walletCreatedAt` do not re-trigger a backfill scan. The `walletCreatedAt` field bounds the backfill window; without it, the backend uses `TX_INDEXER_BACKFILL_BLOCKS` (default 10_000 blocks, ~14h on Celo) as the default depth.

Kill switch: `TX_WATCH_ENABLED` (env, per-request). Default `true`.

`GET BASE/api/transactions/feed?address=&networkIds=celo-mainnet&includeTypes=<CSV>&localCurrencyCode=USD&afterCursor=<cursor>`:
```
Response: 200 {
  "transactions": Transaction[],
  "pageInfo": { "endCursor": "...", "hasNextPage": true|false }
}
```

`Transaction` shape depends on `type` (`RECEIVED`, `SENT`, `SWAP_TRANSACTION`, `DEPOSIT`, `WITHDRAW`, `CLAIM_REWARD`, ...). Key fields wallet consumes:
- `type`, `transactionHash`, `block`, `timestamp`.
- `inAmount`, `outAmount` (Valora renderer keys off these names; do NOT rename).
- `fees[].amount.tokenId`, `fees[].amount.value`.
- `fromTokenAmounts[]` for multi-leg 7702 batches (spike v2 `execute` selector `0x3f707e6b`, BatchExecutor at `0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe`).
- `metadata.*` per type.

**Structural gaps documented + accepted** (not indexed today, wallet handles as "not found"):
- Native CELO transfers (no ERC-20 Transfer event).
- `approve`-only txs where only the Approval log is emitted (no user-facing amount).

Kill switch: `TX_FEED_ENABLED` (env, per-request). Default `true`. When `false`, route returns `503 { "error": "tx feed disabled" }`.

`GET BASE/api/transactions/indexer/health`:
```
200 { "lastIndexedBlock": <number>, "celoTipBlock": <number>, "lagBlocks": <number>, ... }
```

For wallet-side telemetry. If `lagBlocks > 100` for >5 min, page.

### 8. Hooks API v2

Drop-in replacement for Valora's `hooks-api`. Two apps wired: `allbridge` (native port) and `neeru-vaults` (partner integration).

`GET BASE/hooks-api/getPositions?address=<addr>&networkIds=celo-mainnet[&networkIds=...]`:
```
200 { "data": Position[] }
```

Returns positions the user holds. Allbridge LPs with non-zero balance + Neeru categories with non-zero amount+accrued. 400 on invalid address / unsupported networkId.

`GET BASE/hooks-api/getEarnPositions?networkIds=celo-mainnet[&address=<addr>][&supportedAppIds=neeru-vaults|allbridge][&supportedPools=<positionId>]`:
```
200 { "data": Position[], "meta"?: { "partialFailure"?: { "neeru"?: true, "allbridge"?: true } } }
```

Full Earn catalogue. Without `address`, every entry has `balance: "0"`. With `supportedAppIds`, filters to that app. With `supportedPools`, filters to specific positionId prefixes.

**Failure semantics:** if the Allbridge upstream or the Neeru contract read throws, that slice is suppressed and a `meta.partialFailure` flag is set. The other slice still returns. Wallet SHOULD honor `partialFailure` and treat the missing slice as unknown (not empty). This is what surfaced the 2026-07-12 selector bug when Neeru read failed and wallet saw empty cards for ~27h (buffered by Statsig gate, no user-visible impact).

**Position shape (Neeru example):**
```json
{
  "type": "app-token" | "contract-position",
  "positionId": "celo-mainnet:<contract>:category-<N>",
  "networkId": "celo-mainnet",
  "appId": "neeru-vaults",
  "appName": "Neeru Vaults",
  "displayProps": {
    "title": "Flexible" | "30 dias" | "60 dias" | "90 dias",
    "description": "...",
    "imageUrl": "https://tucop-backend-production.up.railway.app/assets/neeru/category-<N>.png",
    "manageUrl": "..."
  },
  "dataProps": { ... },
  "tokens": [ ... ],
  "availableShortcutIds": ["deposit", "withdraw", "withdraw-amount-only"],
  "shortcutTriggerArgs": {
    "deposit": { "categoryId": <N>, ... },
    "withdraw": { ... },
    "withdraw-amount-only": { ... }
  }
}
```

**Field name reference (post-2026-07-11 cutover, current):**
- `amount` (was `principal`)
- `category` (was `tranche`)
- `categoryLabel` (was `trancheLabel`)
- `withdraw-amount-only` (was `withdraw-principal-only`)
- `categoryId` in request bodies (was `trancheId`)
- `INVALID_CATEGORY`, `CATEGORY_CAP_EXCEEDED` wire error codes (were `INVALID_TRANCHE`, `TRANCHE_CAP_EXCEEDED`)
- `NEERU_CATEGORY_IMAGE_URL_TEMPLATE` env (was `NEERU_TRANCHE_IMAGE_URL_TEMPLATE`)
- `:category-<N>` positionId suffix (was `:tranche-<N>`)
- `/assets/neeru/category-<N>.png` CDN scheme (was `/assets/neeru/tranche-<N>.png`)

Old names return 404 on any endpoint that took them and are no longer emitted. Wallet's defensive `principal ?? amount`-style fallbacks in adapters can be dropped for 1.118.8; backend does not emit the old names anywhere.

`GET BASE/hooks-api/v2/getShortcuts?networkIds=celo-mainnet[&address=<addr>]`:
```
200 { "data": Shortcut[] }
```

Merged shortcut catalogue:
- `allbridge` -> `deposit`, `withdraw`, `claim-rewards`, `swap-deposit`.
- `neeru-vaults` -> `deposit`, `withdraw`, `withdraw-amount-only`.

`POST BASE/hooks-api/triggerShortcut`:
```
Body:
  {
    "address": "0x...",
    "appId": "allbridge" | "neeru-vaults",
    "networkId": "celo-mainnet",
    "shortcutId": "<from getShortcuts>",
    ...protocol-specific args
  }
Response:
  200 { "data": { "transactions": Tx[], "dataProps": {} } }
  400 { "error": "<code>" }
  502 { "error": "shortcut build failed" }
  503 { "error": "neeru not configured" | "database not configured" }
```

Wallet-facing 400 codes (stable, complete list — `src/hooks-api/routes.ts:264`):
- `INVALID_CATEGORY`
- `INVALID_AMOUNT`
- `DEPOSITS_PAUSED`
- `GLOBAL_CAP_EXCEEDED`
- `CATEGORY_CAP_EXCEEDED`
- `RATE_NOT_SET`
- `AMOUNT_BELOW_MIN`
- `POSITION_NOT_FOUND`
- `POSITION_NOT_OWNED`
- `POSITION_ALREADY_CLOSED`
- `NEERU_NOT_CONFIGURED`

Plus body validation errors: `invalid address`, `invalid tokens`, `invalid positionId`, `unknown appId`, `unknown shortcut`, `unsupported networkId`.

Any other error (upstream, RPC, decode) surfaces as `502 { "error": "shortcut build failed" }` with the underlying message logged server-side but not echoed.

**Per-app body shape:**

`allbridge`:
- `deposit`: `{ positionAddress, tokenAddress, tokenDecimals, tokens: [{ amount }] }`
- `withdraw`: `{ positionAddress, tokenDecimals, tokens: [{ amount }] }`
- `claim-rewards`: `{ positionAddress }`

`neeru-vaults`:
- `deposit`: `{ categoryId, tokens: [{ tokenId, amount }] }`. `categoryId` is `0..3`, `amount` is a decimal integer in whole units.
- `withdraw`: `{ positionId }`. `positionId` is a decimal integer string.
- `withdraw-amount-only`: `{ positionId }`.

**Success response** — every tx is JSON-safe: `value` is a string (`"0"` for non-payable), `data` is encoded calldata, `to` is lowercase 40-hex. Every Neeru shortcut tx carries `gas` + `estimatedGasUse` hints to bypass wallet-side `eth_estimateGas` revert-simulation on batched flows (see PR #123).

### 9. Neeru positions detail

Per-position detail for the "your positions" screen. Custom endpoint (not `hooks-api`), same auth model.

```
GET BASE/api/earn/neeru/positions?address=<lowercase-hex-addr>
```

Response:
```json
{
  "data": {
    "address": "0x...",
    "positions": [
      {
        "positionId": "<opaque>",
        "category": 1,
        "categoryLabel": "30 dias" | "Flexible",
        "amount": "<decimal-formatted>",
        "accruedInterest": "<decimal-formatted>",
        "monthlyRatePercentage": <numeric>,
        "startTs": <unix-seconds>,
        "endTs": <unix-seconds>,
        "depositBlock": <opaque>,
        "depositTxHash": "0x...",
        "renewedFromPositionId": null,
        "currentPayoutIfClosed": {
          "amount": "<decimal-formatted>",
          "interest": "<decimal-formatted>",
          "penaltyBps": <numeric>,
          "interestAfterPenalty": "<decimal-formatted>",
          "total": "<decimal-formatted>",
          "isEarly": true | false
        }
      }
    ],
    "lastSyncedBlock": <opaque>,
    "lastSyncedAt": "<iso8601>"
  }
}
```

Behavior notes:
- `address` must be lowercase 40-hex. Mixed-case returns `400 invalid address`.
- Unknown query params return `400 unknown param` (strict allowlist).
- `currentPayoutIfClosed.isEarly` is `true` only when the category is locked AND `now < endTs`.
- `renewedFromPositionId` is always `null` (indexer schema does not track renewal chains).
- `lastSyncedBlock` / `lastSyncedAt` come from `neeru_indexer_state`; use to warn the user if partner data is stale.
- Read-side is cached in-process 30s per address.

Error responses:
- `400 { "error": "invalid address" }`
- `400 { "error": "unknown param" }`
- `502 { "error": "detail fetch failed" }` on RPC / infra
- `503 { "error": "database not configured" }` (`DATABASE_URL` unset)
- `503 { "error": "neeru not configured" }` (`NEERU_DEPOSIT_TOKEN_ADDRESS` unset)

### 10. Events proxy

```
GET BASE/events?address=<addr>&topic0=<hex>
```

Proxies Etherscan's event query with whitelisted contract addresses (`ALLOWED_CONTRACTS` in `src/routes/events.ts`). Non-whitelisted -> `403`. Malformed inputs -> `400`. Upstream error -> `502 { "error": "etherscan error" }` (never echoes upstream).

## Backend kill switches (env-driven)

Every switch is evaluated per-request (not at boot) so a flip takes effect on the next request without a Railway restart. Defaults listed. Env var name is exactly as backend reads it.

| Env var | Default | Effect when disabled | Route(s) affected |
|---|---|---|---|
| `WRI_FEE_BOOTSTRAP_ENABLED` | `false` (currently `true` in prod) | `503 { error: "fee bootstrap disabled" }` | `POST /api/wri/fee-adapter-bootstrap` |
| `TX_FEED_ENABLED` | `true` | `503 { error: "tx feed disabled" }` | `GET /api/transactions/feed` |
| `TX_WATCH_ENABLED` | `true` | `503 { error: "watch disabled" }` | `POST /api/transactions/watch` |
| `TX_INDEXER_BACKFILL_ENABLED` | `true` | `/watch` still registers, no backfill runs | backfill worker |
| `INDEXER_ENABLED` | `false` (currently `true`) | tx indexer worker does not run | worker only |
| `NEERU_INDEXER_ENABLED` | `false` (currently `true`) | Neeru indexer worker does not run | worker only |
| `NEERU_TIMELOCK_ENABLED` | `false` (currently `true`) | Timelock monitor does not run | worker only |

**No dedicated kill switch for `neeru-vaults` hooks-api or shortcuts.** The Neeru slice fails closed via `partialFailure` on read errors. If backend needs an emergency pause, unset `NEERU_DEPOSIT_TOKEN_ADDRESS` and the Neeru side of every hooks-api endpoint becomes a no-op (Allbridge results still flow).

## Error contract

All wallet-facing errors are `{ "error": "<code-or-message>" }`. No structured error envelope, no error codes namespace, no i18n on backend side.

**Rules:**

1. Upstream error messages (from Etherscan, Blockscout, Squid, viem, Postgres) are NEVER echoed. They are logged server-side and replaced with a generic backend error string (`"<service> error"`, `"detail fetch failed"`, `"shortcut build failed"`).
2. Wallet-fault 400s carry a stable code from a fixed enumerated set (`TRIGGER_USER_ERROR_CODES` above for triggers). Body validation errors carry a short human-readable message (`"invalid address"`, `"unknown appId"`).
3. Infrastructure 5xx: `503` when the backend is intentionally gated / dependency is unavailable, `502` when an upstream failed unexpectedly, `500` for unhandled backend exceptions.
4. Cero-exposure: no error message reveals the partner contract identifier, ABI shape, or specific revert reason from the chain. Chain reverts are logged with full context server-side.

**Wallet-side pattern (recommended):**

- Detect infrastructure failures by status code (`5xx`) and retry with backoff on `502`, do NOT retry on `503` (backend has flagged the feature off, retrying is noise).
- Wallet-fault 400s map to i18n keys via the stable error code, never via message text (message text can change without notice; codes are stable per this spec).
- Body-validation 400s (`"invalid address"` etc.) map to a generic "Invalid request" i18n key on the wallet since these codes are stable but not enumerable.

## Zero-exposure bar (symmetric)

Both repos apply the same rule: tracked source must not let a reader reconstruct the partner contract's ABI surface, field names, or behavior beyond what raw bytecode disassembly reveals. The contract is intentionally not verified on Celoscan.

**Wallet-side responsibilities:**

1. No ABI object with named `functionName` / `eventName` / `error name` for the partner contract in tracked source. Use type-only decoding (`decodeAbiParameters([{type:'uint256'},...], data)`) with topic0 hashes loaded from env. Reference: wallet PR `TuCopFinance/TuCopWallet#265` merge commit `c643f7bad1ef0528a21d52ac8e8a63fd743470bc`.
2. No hardcoded contract address, topic0, or custom-error selector in tracked source. All go through `NEERU_*` env vars (`NEXT_PUBLIC_NEERU_*` on the wallet since it's an RN build) with hex fallback + fail-fast if unset.
3. No semantic field names in wallet-internal models (`principal`, `tranche`, `trancheLabel`, `maturityTs`, `dailyRateRay`, ...). Use the opaque wire names (`amount`, `category`, `categoryLabel`, `endTs`, `rateValue`).
4. No prose comments describing partner-contract behavior in wallet source (`// frozen at deposit`, `// retroactive maturity`, etc.).

**Structural exposure the wallet accepts:**

- `NEERU_DEPOSIT_TOPIC0` value is a hex loaded from env. The topic hash is derivable from `keccak256("Deposit(<sig>)")` if someone knows the event signature, which is bytecode-recoverable. Same category as backend's `functionName: 'tranches'` — required for the runtime to work, accepted as-is.

**Backend-side responsibilities (already in place; documented so the wallet knows what to expect):**

- The backend keeps `functionName: 'tranches'` and `functionName: 'closePositionPrincipalOnly'` in ABI defs because viem needs the literal to derive the selector. These are the ONLY partner-contract names in backend tracked source. Everything else is opaque.
- Backend history was rewritten on 2026-07-11 via `git filter-repo --replace-text` after main was at the clean HEAD.
- One residual: GitHub owns `refs/pull/*/head`, so old PR refs still contain pre-rewrite blobs. Not search-indexed; ignored.

## Rate limits

| Route | Limit | Status when exceeded |
|---|---|---|
| Global (Express `express-rate-limit`) | 120 req/min per IP | `429 { "error": "rate limit exceeded" }` |
| `POST /api/wri/delegate-relay` per-IP | 20/min (`WRI_RELAY_PER_IP_LIMIT`) | `429` |
| `POST /api/wri/delegate-relay` global | 60/min (`WRI_RELAY_GLOBAL_LIMIT`) | `429` |
| `GET /api/swap/quote` | passes through Squid's 10 RPS per-wallet | Squid `429` echoed |

`app.set('trust proxy', 1)` is set so Railway's single LB hop forwards the real client IP. Wallet does not need to send `X-Forwarded-For`.

## Caching + TTLs

| Data | Cache | TTL | Invalidation |
|---|---|---|---|
| Blockscout responses | Redis (public URL) | 30s per query-key | none, expires naturally |
| CMC price | Redis | 60s | none |
| Neeru per-category read (`tranches(N)`) | in-process Map | 30s | none |
| Neeru `earlyClaimPenaltyBps` | in-process Map | 30s | none |
| Neeru deposit-token decimals | in-process Map | 30s | none |
| Squid token-info in trigger builder | in-process Map | 30s | none |

Cache keys are built via `src/lib/query.ts:buildCacheKey` (sorted, URL-encoded, reserved params dropped, 512-char cap).

## Verification playbook

For wallet-side smoke tests before every release (paste into your CI or run manually):

```bash
BASE=https://tucop-backend-production.up.railway.app
ADDR=0x82c0e93e1fbcf19fff1f4b10c9ca3ab84e93d626  # any real Neeru holder

# 1. Health
curl -sf $BASE/health              | jq .
curl -sf $BASE/ready               | jq .
curl -sf $BASE/health/relay        | jq .

# 2. Neeru catalog (should return 4 categories, no partialFailure)
curl -sf "$BASE/hooks-api/getEarnPositions?networkIds=celo-mainnet&supportedAppIds=neeru-vaults&address=$ADDR" | jq '.data | length, .meta.partialFailure'

# 3. Shortcut list (should include withdraw-amount-only, not withdraw-principal-only)
curl -sf "$BASE/hooks-api/v2/getShortcuts" | jq '.data[] | select(.appId=="neeru-vaults") | .id'

# 4. Asset URLs (200 on new path, 404 on old)
curl -sI $BASE/assets/neeru/category-0.png | head -1  # HTTP/2 200
curl -sI $BASE/assets/neeru/tranche-0.png  | head -1  # HTTP/2 404

# 5. Neeru detail (unauthenticated shape check)
curl -sf "$BASE/api/earn/neeru/positions?address=$ADDR" | jq 'keys, .data.positions | length'

# 6. Feed indexer health
curl -sf "$BASE/api/transactions/indexer/health" | jq '.lastIndexedBlock, .lagBlocks'
```

If any smoke check regresses, halt the release and page the backend oncall.

## Escalation

- **Wire regressions or shape changes.** Open an issue on `TuCopFinance/TuCOPWallet-Backend` referencing this spec section. Backend oncall responds within 24h on business days.
- **Prod incidents (5xx spike, `partialFailure` flag on Neeru).** Backend Slack channel (or Telegram, whichever the team is on today). Reference this spec's playbook to narrow the failing endpoint.
- **Zero-exposure question.** Read `feedback_cero_exposicion_neeru` in the backend memory or open an issue for clarification. Do not paste partner-contract identifiers in cross-team channels without checking first.
- **Coordinated releases (breaking wire changes).** Backend and wallet cut releases separately, but wire-breaking backend changes MUST be preceded by an updated spec + a coordination thread on Slack. The 2026-07-11 Neeru cutover is the canonical example; see `docs/wallet-coordination-neeru-cutover.md` in this repo.

---

**Spec version:** 2026-07-12. **Last backend deploy verified against:** commit `514ab80` (release PR #132). **Next review triggered by:** any PR touching `src/routes/`, `src/hooks-api/`, `src/transactions-indexer/`, or `src/lib/env.ts`.
