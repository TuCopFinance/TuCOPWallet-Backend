## What changed

<!-- 1-3 bullets describing the actual change. Cite file paths. -->

-
-

## Why

<!-- 1-2 sentences. What bug or feature does this address? Link the issue or roadmap entry. -->

## Test plan

<!-- How did you verify this works? Commands run, scenarios exercised. -->

- [ ] `yarn lint`
- [ ] `yarn typecheck`
- [ ] `yarn test`
- [ ] `yarn build`
- [ ] Manual smoke test (describe):

## Security impact

<!-- Required if this PR touches: src/routes/wri.ts, src/lib/wriRelay.ts, src/lib/wriRateLimit.ts,
     src/hooks-api/, secret loading paths, CORS, rate limits, or input validation.
     Otherwise: "n/a". -->

## Operational considerations

<!-- New env vars? Schema migrations? Rollback caveats? Breaking changes for the wallet client?
     Otherwise: "none". -->

## Wallet integration spec update

Any PR touching `src/routes/`, `src/hooks-api/`, `src/transactions-indexer/`, or `src/lib/env.ts` MUST update the local wallet integration spec. See project `CLAUDE.md` for the full rule.

- [ ] `tasks/specs/wallet-consumer-spec.md` changelog: added a one-line entry for this PR
- [ ] `tasks/specs/wallet-consumer-spec.md` body: updated the affected section (if the delta is significant — new endpoint, new response field, new kill switch, new error code, changed semantics)
- [ ] `yarn docs:env` reports no drift (only relevant if you added / removed / renamed an env var)
- [ ] N/A — this PR does not touch wire, hooks-api, indexer, or env

## Cero-exposicion check

- [ ] I did NOT add partner-contract ABI names, event names, error names, addresses, or behavioral prose to tracked source
- [ ] I did NOT commit content to `docs/` that includes kill switch names/defaults, rate limits, admin paths, incident detail, or wire coordination (those go to `tasks/specs/` gitignored)
- [ ] N/A — this PR does not touch partner-app code or documentation

## Checklist

- [ ] Conventional Commit message on the merge commit
- [ ] `README.md` updated if public surface changed (endpoints, env vars, behavior)
- [ ] `.env.example` updated if new env var added
- [ ] No real wallet addresses or private keys in tests, fixtures, or comments
- [ ] No `console.*` calls; all log output goes through `src/lib/logger.ts`
- [ ] No truncated EVM hex identifiers in logs, errors, or responses
