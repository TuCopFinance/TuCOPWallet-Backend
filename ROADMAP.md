# Roadmap

Backlog of things flagged but not blocking. Revisit once production traffic is flowing and we have real numbers to argue from.

## Review window: end of July 2026

Both items below were flagged on 2026-06-26 during the post-#11 cleanup pass. Plan to look at them again **2-3 weeks after the wallet is deployed** with the new backend in the loop, so we have actual usage data to make the call instead of guessing.

---

## 1. Per-endpoint rate limit tiering

**Status:** today the global limit is 300 req/min/IP (`src/app.ts`). Bumped from 120 in #12 to leave margin for users firing ~10 swaps in 2-3 minutes (quote refresh + receipt polling + feed refresh).

**Why revisit:** a single global bucket means a chatty endpoint (feed polling, blockscout proxy) can eat into the budget of a quieter one (swap, delegate-relay). With production traffic we can see whether that actually happens or whether 300/min is fine for everyone.

**What to look at when we revisit:**

- Railway logs: how often do we see `429 rate limit exceeded`? Group by endpoint to see who is hitting the ceiling.
- Per-IP top requesters in a 60s window: are they real users or scripts?
- If 429s are non-trivial AND concentrated on one endpoint: split into tiered buckets. Rough first cut:
  - `/api/swap/quote`: 60/min/IP (active session ~ 1/5s)
  - `/api/transactions/feed`: 60/min/IP (pull-to-refresh + background refresh)
  - `/api/v2/...` (blockscout proxy): 120/min/IP (receipt polling can spike)
  - `/api/wri/delegate-relay`: stays at 10/min/IP (write path, expensive)
  - Everything else: 60/min/IP
- If 429s are negligible: leave the single global bucket alone, close this item.

**How to implement when we decide to:** `express-rate-limit` supports per-router middleware. Mount one `rateLimit(...)` per `router.use(...)` instead of the single global one in `app.ts`. Keep the global `300/min` as a safety net on top.

---

## 2. Per-address `wriRateLimit` Map fallback when Redis is unavailable

**Status:** the WRI delegate relay now ships with a 3-tier limiter (per-IP via `express-rate-limit`, global token bucket via Redis, per-address via Redis-with-Map-fallback). The global tier is already Redis-required and fail-closed (returns 503 `rate limiter unavailable` when Redis is down), and the per-address Map fallback is bounded to 10k entries (`src/lib/wriRateLimit.ts`).

That largely defuses the original "drain N times faster at N instances" concern: the global tier blocks the abuse pattern regardless of how many instances are running. The remaining gap is narrow but real -> when Redis is unavailable, the per-address tier degrades to per-instance Map, so a single user could theoretically retry once per instance within the 5-minute window before the global tier (which is also down) becomes moot.

**Why revisit:** we are still on a single Railway instance; the gap is dormant. Once we scale OR if we want consistency with the global tier, we should make the per-address tier Redis-required + fail-closed too.

**What to look at when we revisit:**

- Is Railway still on a single instance? Check the deploy.
- If still 1 instance: do nothing, this is a non-issue today.
- If 2+ instances: align the per-address tier with the global tier:
  - **Option A:** make Redis a hard requirement for `/api/wri/delegate-relay`. Return `503 relay temporarily unavailable` if the per-address limiter cannot reach Redis. Smallest change; consistent with the global tier's behaviour.
  - **Option B:** enforce the per-address limit on-chain instead (e.g. read the user's nonce or a delegation marker). More work, no Redis dep, more correct but slower per request.

**Recommendation when we revisit:** Option A.

---

## Closed (for historical reference)

- 2026-07-08 to 2026-07-10: transactions-indexer hardening trail after the WRI_TX_FEED_TUCOP_V1 rollout hit 100%. Wallet team's diff-runner surfaced a series of coverage and classification residuals across two spike v2 measurements; each got closed with a targeted PR + release. Full paper trail:
  - **#107 (release #108, 2026-07-08)** `fix(tx-indexer): classify Squid multi-hop swaps (fundAndRunMulticall)`. `classifyAggregatorSwap` used to require the outbound and inbound Transfer legs to share a common counterparty. Squid Router routes through DIFFERENT Mento pools per leg so the counterparty sets do not intersect. New `KNOWN_AGGREGATOR_TARGETS` registry (Squid Router `0xce16f69375520ab01377ce7b88f5ba8c48f8d666`) skips the intersection check when `tx.to` matches. `CACHE_SCHEMA_VERSION` 5 -> 6.
  - **#109 (release #110, 2026-07-08)** `fix(tx-indexer): upsert classified cache + safety buffer on walletCreatedAt fromBlock`. Two bugs. (a) `classified_tx_cache` INSERT used `ON CONFLICT DO NOTHING` so v(n-1) rows never got refreshed when the schema bumped; `tryReadCache` returned null on version mismatch but `writeCache` never persisted the fresh payload. Switched to `DO UPDATE SET payload_json = EXCLUDED.payload_json` so cache converges on the next /feed hit. (b) `walletCreatedAtToFromBlock` assumed exactly 1 s/block post-L2; real Celo L2 averages ~1.04 s/block, so 16-day windows fell short by ~4-8k blocks. Added a 50k-block safety buffer added BEFORE the 5M cap.
  - **#111 (release #112, 2026-07-08)** `feat(tx-indexer): admin reset-backfill + loud silent-fail logs`. `rpcFetchTx` had two return-null branches (blockNumber missing, receipt malformed) with zero log output; both now `log.warn` before returning null. New `POST /api/admin/reset-backfill` with `Authorization: Bearer <TX_ADMIN_TOKEN>` (constant-time compare). Clears the five backfill fields on a single row so the next /watch re-inits from scratch. Route gates to 503 when `TX_ADMIN_TOKEN` is unset so a leaked URL is inert.
  - **#113 (release #114, 2026-07-10)** `fix(tx-indexer): bump walletCreatedAt safety buffer 50k -> 300k`. The 50k buffer sized for 14-day windows fell short on spike-lifecycle wallets that /watch weeks after their real creation date. Bumped to 300k which covers 60-day windows at 5% block-time slippage. Still bounded by `SAFETY_MAX_BACKFILL_BLOCKS` (5M).
  - **#115 (release #116, 2026-07-10)** `fix(tx-indexer): classify increaseAllowance as APPROVAL`. Wallet team's diff surfaced 3 spike v2 txs using OpenZeppelin's non-standard `increaseAllowance(address,uint256)` (`0x39509351`) that our classifier dropped because it matched only `SELECTOR_APPROVE`. Same calldata shape, semantically equivalent. `decreaseAllowance` intentionally NOT matched (revocation != approval).
  - **#117 (release #118, 2026-07-10)** `fix(tx-indexer): bump CACHE_SCHEMA_VERSION 6 -> 7 for increaseAllowance`. Follow-up to #115: I forgot to bump the schema, so v6 payloads previously cached as `[]` for the newly-classified txs kept short-circuiting `tryReadCache` before the new classifier could run. Bump forces re-classification once and the payloads UPSERT correctly (thanks to #109).
  - **Structural gaps documented, deferred by design:** native CELO discovery in backfill (getLogs only surfaces `Transfer` events, native sends emit nothing) and pre-/watch `approve` / `increaseAllowance` with 0 Transfer log (same discovery model). Recovering either would need `getBlock(includeTransactions: true)` across the full backfill window - RPC budget prohibitive, low product impact given the wallet does not surface CELO to users and fee-abstraction handles gas. Wallet team explicitly closed both as "sin follow-up".
  - **Post-fix state on spike v2 (2026-07-10):** 129 total txs indexed across 2 /feed pages, diff-runner parity with Valora on all Squid multi-hop + `increaseAllowance` cases. Rollout stayed at 100% throughout; no kill switch flipped either side.

- 2026-07-06: transactions-indexer track C shipped end-to-end. Phases 2 through 5 of the WRI Transaction Feed Indexer plan + Earn types + walletCreatedAt deep backfill all live in Railway production. Specifically:
  - `/api/transactions/watch` accepts optional `walletCreatedAt` (ISO 8601). Backfill extends fromBlock via a segmented pre/post-L2 formula, capped at 5M blocks (PR #100, released via #101).
  - `EarnTransaction` classifier for `DEPOSIT` / `WITHDRAW` / `CLAIM_REWARD` runs BEFORE the swap rules so Neeru deposits are no longer folded into bogus swaps. Env-driven registry via `NEERU_CONTRACT_ADDRESS` + `NEERU_EVENT_A/B/C_TOPIC0`; Allbridge pluggable via the same table (PR #100).
  - Wire-shape aligned with the Valora renderer already in production (v1.118.5): `EarnTransaction` carries `appName`, `inAmount`, `outAmount` on top of the TuCop-native `appId`/`positionId`/`amount`. `inAmount === outAmount === amount` share one TokenAmount reference so any renderer branch renders (PR #102, released via #103). Root-caused the shape mismatch pre-flip via wallet-team review.
  - Robust resumable backfill (PR #98/#99): 4-endpoint RPC fallback with per-endpoint circuit breaker, per-chunk cursor checkpoint, boot-time resume for pending backfills, adaptive backoff.
  - `CACHE_SCHEMA_VERSION` walked 1 -> 5 across the day as the shape evolved. `TX_INDEXER_BACKFILL_ENABLED`, `TX_FEED_ENABLED`, `TX_WATCH_ENABLED` kill switches live in Railway env.
  - Wallet team flipped `WRI_TX_FEED_TUCOP_V1` gate to 10% at 2026-07-06T20:57Z. 24-48h observation window before bump to 50%.

- 2026-06-27: hooks-api workstream landed (#14, #15, #16, #17, #18). Backend now serves the wallet's Earn surface end-to-end without depending on Valora's hosted hooks-api. Live in Railway production; env vars provisioned, indexer worker enabled, smoke-tested all 5 endpoints returning expected shapes. Wallet URL flip to `https://tucop-backend-production.up.railway.app/hooks-api` is the next gate; until then both stacks run in parallel.
- 2026-06-27: hotfix #19 lowered the indexer's `MAX_BLOCKS_PER_BATCH` from 10k to 5k. Surfaced on the first live deploy: the 3 Celo public RPCs (Forno, Ankr, dRPC) all cap `eth_getLogs` ranges at 5000 blocks. Before the fix every tick bounced off all 3 endpoints and the 5-minute backoff kicked in, so the indexer never wrote a row. Lesson: pin a smoke check on `lastSyncedBlock` advancement (not just deploy SUCCESS) when enabling the indexer in a new environment.
- 2026-06-28: #20 added `rpc.celocolombia.org` as the primary Celo RPC for both the indexer and the Allbridge port, with `forno -> ankr -> drpc` as fallbacks. The 3-failure / 5-minute circuit breaker in the indexer was renamed from Forno-specific to a generic "primary" so it protects the new endpoint instead of Forno. Also (superseded by 2026-06-29 entry below): Railway's GitHub auto-deploy missed two consecutive pushes to main (#19 + #20); workaround at the time was to set a no-op env var (e.g. `_DEPLOY_TRIGGER_AT=<timestamp>`) which always triggers a fresh build from main HEAD. The deeper fix landed on 2026-06-29.
- 2026-06-29: replaced Railway's flakey native GitHub integration with a self-hosted GH Actions deploy workflow (`24365be`, validated end-to-end via PR #22). `.github/workflows/deploy-railway.yml` fires via `workflow_run` after `CI` succeeds on `main` and calls `serviceInstanceDeployV2` with the head SHA. Closes the workaround noted in the 2026-06-28 entry above; the no-op env-var bump is no longer needed. Push -> live latency observed: ~3-4 min (CI ~1m50s + workflow_run handoff ~10s + Railway build/deploy ~30-60s), vs. the 15-20 min the native webhook took when it fired at all.
- 2026-06-26: bumped global rate limit 120 -> 300/min/IP (#12) so an active user firing ~10 swaps in 2-3 minutes does not hit the wall. Original 120 was set arbitrarily early in the project lifecycle.
