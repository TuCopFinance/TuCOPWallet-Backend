# Roadmap

Backlog of things flagged but not blocking. Revisit once production traffic gives us real numbers to argue from.

## 1. Per-endpoint rate limit tiering

**Status:** today the write path (`/api/wri/delegate-relay`) has its own limits on top of the global per-IP bucket. Everything else shares the global bucket.

**Why revisit:** a single global bucket means a chatty endpoint (feed polling, blockscout proxy) can eat into the budget of a quieter one (swap, delegate-relay). With production traffic we can see whether that actually happens or whether the current sizing is fine for everyone.

**What to look at when we revisit:**

- Are we seeing meaningful 429 volume in Railway logs? Group by endpoint to see who is hitting the ceiling.
- Per-IP top requesters in a short window: are they real users or scripts?
- If 429s are non-trivial AND concentrated on one endpoint, split into tiered buckets per route. If negligible, leave the single global bucket alone and close this item.

**How to implement when we decide to:** `express-rate-limit` supports per-router middleware. Mount one `rateLimit(...)` per `router.use(...)` instead of the single global one in `app.ts`. Keep the global bucket as a safety net on top.

## 2. Per-address `wriRateLimit` Map fallback when Redis is unavailable

**Status:** the WRI delegate relay ships with a 3-tier limiter (per-IP via `express-rate-limit`, global token bucket via Redis, per-address via Redis-with-Map-fallback). The global tier is Redis-required and fail-closed (returns 503 when Redis is down), and the per-address Map fallback is bounded (`src/lib/wriRateLimit.ts`).

That largely defuses the original "drain N times faster at N instances" concern: the global tier blocks the abuse pattern regardless of how many instances are running. The remaining gap is narrow but real -> when Redis is unavailable, the per-address tier degrades to per-instance Map, so a single user could theoretically retry once per instance within the window before the global tier (which is also down) becomes moot.

**Why revisit:** we are still on a single Railway instance; the gap is dormant. Once we scale OR if we want consistency with the global tier, we should make the per-address tier Redis-required + fail-closed too.

**What to look at when we revisit:**

- Is Railway still on a single instance? Check the deploy.
- If still 1 instance: do nothing, this is a non-issue today.
- If 2+ instances: align the per-address tier with the global tier:
  - **Option A:** make Redis a hard requirement for `/api/wri/delegate-relay`. Return `503 relay temporarily unavailable` if the per-address limiter cannot reach Redis. Smallest change; consistent with the global tier's behaviour.
  - **Option B:** enforce the per-address limit on-chain instead (e.g. read the user's nonce or a delegation marker). More work, no Redis dep, more correct but slower per request.

**Recommendation when we revisit:** Option A.
