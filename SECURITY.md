# Security Policy

TuCopWallet-Backend custodies a hot wallet that pays gas for EIP-7702 delegation setup (`WRI_RELAY_PK`), proxies third-party APIs (Etherscan, CoinMarketCap, Blockscout, Squid), and serves the Earn surface for the TuCop wallet. Security reports are taken seriously and triaged within 72 hours.

## Reporting a vulnerability

Please report security vulnerabilities **privately**, never via a public issue or pull request.

**Email:** `security@tucop.xyz`

Include in your report:

- A clear description of the vulnerability and the affected component (`/api/wri/delegate-relay`, hooks-api, Blockscout proxy, indexer, etc.).
- Step-by-step reproduction (request shape, payload, expected vs observed behaviour).
- Your assessment of impact (drain of relay hot wallet, exfiltration of user data, RCE, denial of service, etc.).
- Optional: a suggested fix.

If your report includes proof-of-concept exploit code, please mark it clearly.

## Response timeline

| Stage | SLA |
|---|---|
| Initial acknowledgement | 72 hours |
| Triage + severity classification | 7 days |
| Fix for critical / high severity | 30 days |
| Fix for medium / low severity | best effort |

If we cannot meet a deadline we will tell you why.

## Scope

**In scope:**

- Extraction or unauthorized use of the WRI relay private key (`WRI_RELAY_PK`).
- Signature replay or authorization bypass on `/api/wri/delegate-relay`.
- Patterns that drain the relay hot wallet (rate-limit bypass, address spraying, gas amplification).
- Server-side request forgery (SSRF) via the Blockscout / Etherscan / Squid / CoinMarketCap proxy routes.
- SQL injection, XSS reflected through error responses, prototype pollution, command injection.
- Authentication/authorization bypass on any endpoint.
- Indexer denial of service (RPC amplification, advisory-lock starvation, DB pool exhaustion).
- Information disclosure: leakage of `WRI_RELAY_PK`, `ETHERSCAN_API_KEY`, `COINMARKETCAP_API_KEY`, `SQUID_INTEGRATOR_ID`, `BLOCKSCOUT_API_KEY`, or `DATABASE_URL` via logs, error messages, or response bodies.
- Inconsistencies in the Neeru / Allbridge calldata builder (`/hooks-api/triggerShortcut`) that let a user submit a transaction with parameters they did not intend.

**Out of scope:**

- Findings that require physical or admin access to TuCop infrastructure (Railway dashboard, Postgres console, etc.).
- Social engineering of TuCop staff or contributors.
- Vulnerabilities in third-party dependencies that are already disclosed upstream and pending a patch release (please report those to the upstream maintainer).
- Vulnerabilities in services we proxy (Etherscan, CoinMarketCap, Blockscout, Squid) - report those to the respective vendor.
- Rate-limit bypass that does not amplify into a drain or DoS (e.g. exceeding the 300 req/min/IP ceiling by a few percent).
- Self-XSS or attacks requiring an already-compromised user device.
- Missing security headers on responses that do not set cookies or sessions (the API is stateless).
- Open redirects on the API (the API does not perform redirects).

## Coordinated disclosure

We follow coordinated disclosure: please give us a reasonable time window (the SLA above) to fix the issue before publishing details. If you wish to publish after the fix ships, we will credit you in the release notes unless you prefer to remain anonymous.

## What to expect

- We will acknowledge your report within 72 hours.
- We will investigate, classify severity (critical / high / medium / low), and communicate our plan back to you.
- We may ask follow-up questions or request additional reproduction details.
- Once a fix is ready and deployed, we will notify you. If you want to publish a write-up, we will coordinate the timing.

Thanks for helping keep TuCopWallet-Backend (and its users) safe.
