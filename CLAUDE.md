# TuCOPWallet-Backend — project rules

Project-scoped instructions for Claude Code (and any AI dev tool) working in this repo. Complements the user's global `~/.claude/CLAUDE.md` and the individual `~/.claude/rules/*.md` files; where anything here conflicts with global, global wins.

## Repo layout at a glance

- `src/routes/` — HTTP surface consumed by TuCop Wallet + partner integrations.
- `src/hooks-api/` — Valora-compatible hooks-api v2 (allbridge + partner apps).
- `src/transactions-indexer/` — feed indexer (backfill + tick worker + persistence).
- `src/neeru-indexer/` — partner-app indexer (opaque names on purpose, see cero-exposicion below).
- `src/neeru-timelock/` — partner-app timelock monitor.
- `src/lib/` — shared plumbing (env, logger, redis, celoClient, RPC fallback, WRI relay).
- `docs/` — **public** documentation. Anyone on the internet can read.
- `tasks/specs/` — **local, gitignored**. Operational detail, wallet-team integration guide, wire coordination, incident detail. Use this for anything sensitive.
- `tasks/` (other subdirs) — plans, audits, other bilateral artifacts. Also gitignored.
- `JOURNAL.md` — local, gitignored. Chronological record of every meaningful change. Updated per PR.
- `MEMORY.md` (root) — not present; user-scoped memory lives under `~/.claude/projects/-.../memory/`.

## Non-negotiable rules

1. **Repo is public.** Anything committed to git is world-readable. Kill switch names + defaults, rate limits, admin paths, incident detail, error-code enumerations, contract addresses of partner apps, and wire coordination all belong in `tasks/specs/` (gitignored), NEVER in `docs/`. Apply the gate at commit-time — if you're about to `git add docs/foo.md` and the content includes any of the above, stop and move to `tasks/specs/`.

2. **Cero exposicion for the Neeru partner contract.** Tracked source must NOT leak the partner contract's ABI shape, event names, custom error names, prose behavior descriptions, or semantic identifiers. Only two literals are allowed in source (needed for viem selector derivation): `functionName: 'tranches'` and `functionName: 'closePositionPrincipalOnly'`. Everything else is opaque (topic0 hashes from env, generic wire names like `amount`/`category`, no comments describing partner behavior). Full rules + audit checklist in the user memory `feedback_cero_exposicion_neeru.md`. When editing anything under `src/neeru-indexer/` or `src/hooks-api/neeru/`, read that memory first.

3. **Wallet integration spec keeps up with wire changes.** Every PR that touches `src/routes/`, `src/hooks-api/`, `src/transactions-indexer/`, or `src/lib/env.ts` MUST update `tasks/specs/wallet-consumer-spec.md`:
   - **Always:** add ONE line to the "Changelog" section at the top of the spec. `- YYYY-MM-DD PR #N: one-sentence summary of the wire delta`.
   - **When the delta is significant** (new endpoint, new response field, new kill switch, new error code, changed semantic): also update the relevant section body with the detail.
   - The PR template in `.github/pull_request_template.md` has a checkbox to confirm this. Reviewer catches if unchecked.

4. **No secrets in commits.** Standard, but especially: never commit `.env`, `.env.local`, `.env.production`, private keys, API tokens, or anything under `tasks/secrets/`. `.gitignore` covers the common paths; do not create new bypass paths.

5. **Branch flow.** `development` is the integration branch. `main` is production. Every PR against `development`. Release PR merges `development` -> `main`. NEVER push direct to `main`. Deploys trigger on any `main` push. Merge method for release PRs: `--merge` (not `--rebase`; branch protection blocks the resulting force-push).

## Conventions

- **Comments:** default to none. Only add when the WHY is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug, behavior that would surprise a reader). Do NOT describe WHAT the code does — the identifiers do that. See the global rules for the full "comments discipline" bar.
- **Logging:** never use bare `console.log` / `console.warn` / `console.error` in feature code. Always go through `src/lib/logger.ts` (`createLogger('namespace')`). Production log level is WARN, so `log.info(...)` is a noop in prod — reserve for dev/debug. For business-critical events that need production visibility (audit trails, reconciliation-relevant events), use `log.warn(...)` even if not an error, WITH a structured JSON payload the log processor can parse.
- **Env vars:** all env access goes through the zod-validated `env` object exported from `src/lib/env.ts`. Do NOT read `process.env.X` directly outside of `lib/env.ts` unless the value needs to be re-read per-request (kill switch flags — allowed for the flip-without-redeploy pattern). Conditional required-vars use the cross-field refinement block at the bottom of `parseEnv`.
- **RPC clients:** long-lived clients (viem, pg, redis) MUST be process-wide singletons that both the warmup path AND every request handler consume. Per-file `let client = null` + lazy init silently splits the connection pool and defeats warmup. Precedent: PR #163 -> #164 (Neeru cold-idle fix, 20.6s -> 0.32s). Rule saved in user memory `feedback_shared_client_singleton.md`.

## Deploy + observability

- **Prod URL:** `https://tucop-backend-production.up.railway.app`
- **Railway project:** `TuCop Wallet` (`a65b8682-cbf2-48cc-b62f-f6b5bc69a994`)
- **Service:** `tucop-backend` (`1dba41cc-5f72-42e7-b766-4c52d2321371`)
- **Environment:** `production` (`4ce202c9-7505-42ff-92d1-a41b06ef1631`)
- **Deploy trigger:** GH Action `deploy-railway.yml` fires on `workflow_run` after CI on `main`.
- **Health checks:** `GET /health` (liveness), `GET /ready` (readiness with dep checks + Neeru warmup gate).
- **Metrics:** `GET /metrics` (Prometheus text).

## When editing wire-facing code

Checklist before opening a PR that touches request / response shape or env-driven behavior:

1. Did I update `tasks/specs/wallet-consumer-spec.md` changelog? (one line minimum)
2. Did I update the relevant section body if the delta is significant?
3. Do the existing tests still pass? (`yarn tsc --noEmit && yarn jest --runInBand`)
4. Did I add a test for the new behavior?
5. Is the change backwards-compatible for wallets currently in stores? (adding OPTIONAL fields to responses = safe; renaming or removing = requires coordination)
6. Do I need to update `docs/api.md` (public)? Only for generic wire shape (field name + type). Any operational detail (kill switch name, rate limit tuning) belongs in the local spec, NOT here.

The PR template embeds these as a checklist so reviewers can catch skips.

## Env vars auto-doc

Run `yarn docs:env` after modifying `src/lib/env.ts` to regenerate the kill-switch section of the wallet spec. Manual updates are also fine when the change is nuanced enough that the auto-gen would drop context.

## Local specs to know

- `tasks/specs/wallet-consumer-spec.md` — full wallet integration spec (the "read this if you're on the wallet team" doc).
- `tasks/specs/wallet-coordination-neeru-cutover.md` — 2026-07-11 cutover playbook.
- `tasks/specs/wallet-neeru-hardcoded-cleanup.md` — cleanup follow-up spec.

## User memory referenced from this project

The user's project-scoped memory at `~/.claude/projects/-Users-0xj4an-Workspaces-tucop-finance-code-TuCOPWallet-Backend/memory/` carries operational knowledge that complements this repo (Railway deploy specifics, RPC fallback lore, wallet team coordination patterns, incident postmortems). When starting a session, `MEMORY.md` in that directory is loaded automatically.
