# TuCop Wallet <-> Backend: Neeru API cero-exposicion cutover

Date: 2026-07-11
Owner: TuCop backend
Contact: personal@0xj4an.xyz

## What is happening

The backend is renaming every partner-contract-mirroring wire identifier on the Neeru integration to opaque names. Once this ships to production, the wallet app currently in the Play/App Store (which reads the OLD names) will render blank or NaN Neeru Earn cards until the wallet team ships a matching release.

The rename is a hard cutover, not a dual-name compat window. Please do not depend on the old names surviving past the deploy.

## What changed on the wire

### Response payload (READ path)

Endpoints: `/api/v2/positions/:address`, `/hooks-api/getPositions`, `/hooks-api/getEarnPositions`, `/api/earn/neeru/positions`.

Old field name -> new field name (in every position + `currentPayoutIfClosed` object):

- `principal` -> `amount`
- `tranche` -> `category`
- `trancheLabel` -> `categoryLabel`

Behavior: exactly the same. Only the JSON key name changed. Values, types, and semantics are unchanged.

### Request body (SEND path)

Endpoint: `POST /hooks-api/triggerShortcut`, `appId: "neeru-vaults"`, `shortcutId: "deposit"`.

Old body field -> new body field:

- `trancheId` -> `categoryId`

Everything else in the deposit body is unchanged. The `categoryId` accepts the same integer range (0..3) with the same semantics.

### Shortcut identifiers (SEND path)

`GET /hooks-api/v2/getShortcuts` used to list Neeru shortcut ids:

- `deposit` (unchanged)
- `withdraw` (unchanged)
- `withdraw-principal-only` -> `withdraw-amount-only`

Update the wallet action-sheet code that keys on `withdraw-principal-only` to switch to `withdraw-amount-only`. Behavior is identical (closes a position recovering only the deposit amount, no interest).

### Wire error codes (READ path on trigger errors)

Body validation errors returned by `POST /hooks-api/triggerShortcut` for the Neeru app include two renamed codes:

- `INVALID_TRANCHE` -> `INVALID_CATEGORY`
- `TRANCHE_CAP_EXCEEDED` -> `CATEGORY_CAP_EXCEEDED`

Update any error-string switch on the wallet side.

### positionId format

Old suffix -> new suffix:

- `celo-mainnet:<contract>:tranche-<N>` -> `celo-mainnet:<contract>:category-<N>`

If any wallet-side cache or lookup keys on the `:tranche-` suffix, migrate to `:category-`.

### CDN icons

Old path -> new path:

- `https://cdn.tucop.xyz/neeru/tranche-{N}.png` -> `https://cdn.tucop.xyz/neeru/category-{N}.png`

Backend ops will re-upload both paths for a transition window so switching is safe.

## What DID NOT change (structural exposure, keep as-is)

- The on-chain contract ABI function names `tranches(uint256)` and `closePositionPrincipalOnly(uint256)` remain unchanged. These are the actual Solidity function selectors on the deployed partner contract and cannot be renamed. Wallet code that constructs raw calldata for these functions does not need to change.

## Suggested cutover sequence

1. Wallet team ships a release that reads BOTH old and new names during the transition:
   - Reader: prefer new name, fall back to old.
   - Sender: send the new field name.
   - Shortcut id switch: check for both `withdraw-amount-only` and `withdraw-principal-only`.
2. Wallet release rolls out.
3. Backend deploys the cutover (this PR / release).
4. After a week of green metrics, wallet team removes the fallback code path.

## Bonus context

This cutover is part of the tighter `cero-exposicion` bar for the backend repo (the source is public on GitHub and we do not want partner-contract-mirroring identifiers indexed by search or scrapers). It is not a functional or security incident.

## Verification

Once deployed, hitting `/api/v2/positions/:address?address=<any-known-neeru-holder>` should return JSON with `amount`, `category`, `categoryLabel` keys. `principal`, `tranche`, `trancheLabel` will be absent.

## Rollback

Backend has a rollback path (revert the release PR + redeploy). Wallet-side rollback = ship the old app. If we hit a critical bug post-deploy, we roll back the backend first; wallet fallback code path (if step 1 above is honored) makes the rollback transparent.
