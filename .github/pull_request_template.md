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

## Checklist

- [ ] Conventional Commit message on the merge commit
- [ ] `README.md` updated if public surface changed (endpoints, env vars, behavior)
- [ ] `.env.example` updated if new env var added
- [ ] No real wallet addresses or private keys in tests, fixtures, or comments
- [ ] No `console.*` calls; all log output goes through `src/lib/logger.ts`
- [ ] No truncated EVM hex identifiers in logs, errors, or responses
