# Contributing to TuCopWallet-Backend

Thanks for considering a contribution. This guide is the short version of "how we work here"; the longer rationale is in `README.md` and `ROADMAP.md`.

## Before you start

- Read `README.md` for the endpoint reference and `ROADMAP.md` for what is in-flight.
- For non-trivial changes (new endpoint, schema migration, new env var), open an issue first to discuss the design.
- For security issues, **do not open a public issue**. See `SECURITY.md`.

## Local development

```bash
cp .env.example .env
# Fill in ETHERSCAN_API_KEY at minimum (required to boot).
# Everything else is optional and documented per-section in .env.example.
yarn install
yarn dev
```

The server listens on `:8080`. Smoke test:

```bash
curl 'http://localhost:8080/health'
```

Postgres and Redis are optional in local dev. When `DATABASE_URL` is unset, the transactions + Neeru indexers are no-ops and the routes that need them return `503`. When `REDIS_URL` is unset, caching is disabled and every request goes direct to upstream.

## Branch workflow

This repo uses two long-lived branches:

- `development`: integration branch. All feature PRs target this.
- `main`: protected release branch. Only merged to via a `development -> main` PR when a batch is ready to ship; merging to `main` auto-deploys to Railway.

Day-to-day flow:

1. `git checkout development && git pull`
2. `git checkout -b <type>/<short-description>` where `<type>` is one of `feat`, `fix`, `chore`, `docs`, `test`, `refactor` (mirror the Conventional Commit types).
3. Make changes, commit, push.
4. Open a PR with **base = `development`**.
5. CI must pass (lint + typecheck + tests + build) before review.

Never push directly to `main`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org). The repo's history is consistent: scan `git log --oneline | head -30` for the in-house style.

Format: `<type>(<scope>): <subject>`

- `<type>`: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `style`, `perf`
- `<scope>`: optional, lowercase, usually the area (`wri`, `swap`, `neeru-indexer`, `hooks-api`, `lib/db`, etc.)
- `<subject>`: lowercase imperative ("add", not "added"), no trailing period, soft cap ~70 chars

Examples from the repo:

```text
feat(neeru-indexer/worker): add pg advisory lock + consecutive-error escalation
fix(wri): fail-closed Redis rate limiter + tighten r/s to 32-byte hex
refactor(events): consume CELO_MAINNET_CHAIN_ID + harden query coercion + validate block range
chore(env): expand .env.example with all required + optional vars grouped by feature
docs(readme): redact Neeru example values + trigger error code list (cero exposicion)
```

Body (optional but encouraged for non-trivial changes) explains the **why**, not the what. The diff already shows the what.

## Before opening a PR

```bash
yarn lint        # ESLint must be clean
yarn typecheck   # TypeScript strict, no errors
yarn test        # Jest suite must pass; coverage threshold 70/60/70/70 enforced
yarn build       # Confirm the dist output builds
```

If any of those fail locally, CI will too. Don't push broken code expecting CI to tell you - it wastes time and bot minutes.

## Code style

- TypeScript strict + `noUncheckedIndexedAccess`. Don't disable.
- Avoid `as any`. `as unknown as <T>` is acceptable when bridging viem's deeply-generic types, but isolate the cast behind a single helper rather than copy-pasting.
- All log output goes through `src/lib/logger.ts` with a per-module namespace (`createLogger('routes:wri')`, `createLogger('neeru-indexer:rpc')`, etc.). Do not call `console.*` directly.
- Inputs at the boundary (route handlers, env vars) must be validated. Use the regex helpers in `src/lib/hex.ts` and the env helpers in `src/lib/env.ts`.
- Never truncate EVM hex identifiers (addresses, tx hashes) in logs, errors, or responses. Use the full string, always.
- Never use real wallet addresses as test fixtures. Synthesize obviously-fake values like `0x3333333333333333333333333333333333333333`.

## PR description

Use the template that auto-loads when you open a PR. The minimum:

- **What changed** (1-3 bullets)
- **Why** (1-2 sentences; what bug or feature this addresses)
- **Test plan** (how you verified)

For changes that touch the WRI relay, the Neeru indexer, or the secret-loading paths, also include:

- **Security impact** (1 paragraph)
- **Operational considerations** (any env vars added, migrations needed, rollback caveats)

## Adding a new endpoint

1. Define the route handler in `src/routes/<name>.ts` (or under `src/hooks-api/` if it's part of the wallet's Earn surface).
2. Add input validation using `src/lib/hex.ts` regex helpers and an explicit allowlist for any enum-shaped param.
3. Wire upstream HTTP calls through `src/lib/http.ts` (`fetchWithTimeout`).
4. Catch upstream errors and map to clean `4xx` / `5xx`; never echo upstream message text to the client response.
5. Add `*.test.ts` next to the source file. Cover at minimum: happy path, each validation failure, each upstream-error mapping.
6. Document the endpoint in `README.md` under `## Endpoints` with: query/body params table, success response shape, error responses table.
7. Add any new env vars to `.env.example` (grouped under the right `# section` comment) and to the env table in `README.md`.

## Adding a new whitelisted contract for `/events`

Edit `ALLOWED_CONTRACTS` in `src/routes/events.ts`. Use lowercase. Open a PR.

## Questions

For project questions, open a Discussion (when enabled) or contact the maintainers via the email in `SECURITY.md` (for sensitive matters) or via the canonical TuCop channels listed at `https://tucop.xyz`.
