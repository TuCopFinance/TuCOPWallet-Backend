# Roadmap

Backlog items flagged but not blocking. Revisited as production traffic surfaces real numbers to argue from.

Operational detail (thresholds, failure-mode analysis, tier defense architecture) lives in local `tasks/specs/backend-operational-details.md` per the public-repo sensitivity gate.

## Current backlog

- **Per-endpoint rate limit tiering**: split the shared global bucket into per-route buckets once prod traffic shows a chatty endpoint is starving a quieter one. Revisit after 30 days of prod traffic + one 429 investigation.
- **Redis dependency alignment for the write-path rate limiter**: harden the multi-instance behavior once we scale past a single Railway replica. Dormant today; revisit when scale changes.

Design detail + implementation options for each item live in the local ops spec.
