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

## 2. `wriRateLimit` in-memory fallback when Redis is unavailable

**Status:** `src/lib/wriRateLimit.ts` enforces 1 successful relay per 5 minutes per `userAddress`. Storage is Redis when `REDIS_URL` is set, an in-process `Map` otherwise.

**Why this matters:** the in-process Map is per-instance. Today we run **a single Railway instance** so the Map is global from the user's perspective. The moment we scale to 2 or more instances:

- User submits a relay request to instance A. Map A says "first time, allow". Limit set in Map A.
- User immediately retries. Load balancer routes to instance B. Map B says "first time, allow". Limit set in Map B.
- Repeat per instance.
- **Result:** the user can call delegate-relay N times in a 5-minute window where N = number of instances, instead of the intended 1. The relay hot wallet drains N times faster than expected.

**What to look at when we revisit:**

- Is Railway still on a single instance, or did we scale up? Check the deploy.
- If still 1 instance: do nothing, this is a non-issue today. Close.
- If 2+ instances: the in-memory path is now incorrect. Two options:
  - **Option A:** make Redis a hard requirement for `/api/wri/delegate-relay`. Return `503 relay temporarily unavailable` if `REDIS_URL` is not set or unreachable. Smallest change.
  - **Option B:** enforce the limit on-chain instead (e.g. read the user's nonce or a delegation marker). More work, no Redis dep, more correct but slower per request.

**Recommendation when we revisit:** Option A is the right default. We already require Redis for other limits at scale; making the relay limit consistent is the cleanest.

---

## Closed (for historical reference)

- 2026-06-26: bumped global rate limit 120 -> 300/min/IP (#12) so an active user firing ~10 swaps in 2-3 minutes does not hit the wall. Original 120 was set arbitrarily early in the project lifecycle.
