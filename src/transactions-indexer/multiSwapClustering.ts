// Cluster N adjacent legacy-sequential Squid multi-swap Dolares -> Pesos
// transactions into a single aggregated SwapTransaction event. Requested
// by the wallet team 2026-08-28. The atomic 7702 path already emits one
// SwapTransaction with `fromTokenAmounts[]` populated; this module gives
// the legacy sequential path (N separate on-chain txs to Squid) the same
// wire shape so the wallet's `SwapFeedItem.isMultiDollarSwap` render
// path collapses both flows into one row.
//
// Design notes:
//
// - Runs at query time on the classified transaction array returned to
//   the feed handler. Kept out of the persistence layer so the DB stays
//   the source-of-truth for individual on-chain txs (deep-link needs
//   per-leg transactionHash regardless of how the aggregate is shown).
// - No cross-page clustering: a cluster split across a page boundary is
//   rendered as "single + cluster(N-1)". Users who paginate see slightly
//   inconsistent grouping at the seam; acceptable given cluster == swap
//   flow completes in ~seconds and page size is 25-50 events.
// - Kill switch: env `INDEXER_MULTI_SWAP_GROUPING_ENABLED` (default
//   `true`, set to `false` to disable via env flip if a false positive
//   ever mis-groups two unrelated user actions).

import type {
  ApprovalTransaction,
  SwapTransaction,
  TokenAmount,
  TokenTransaction,
} from './types'

// Sold-token allowlist. Only clusters that involve exclusively these
// stables collapse into one row; the wallet's `SwapFeedItem` requires
// `EVERY leg be dollar-family` for its `isMultiDollarSwap` render, so
// clustering a mixed cluster wastes work the wallet will not display.
// Addresses lowercased to match tokenId encoding elsewhere.
const DOLLAR_FAMILY_TOKEN_IDS: ReadonlySet<string> = new Set([
  'celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a', // USDm
  'celo-mainnet:0xceba9300f2b948710d2653dd7b07f33a8b32118c', // USDC
  'celo-mainnet:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', // USDT
  'celo-mainnet:0xa2036f0538221a77a3937f1379699f44945018d0', // USAT
])

// Placeholder tokenId for the aggregated `outAmount.tokenId`. USDm is
// used as the display anchor because it is the wallet's default dollar
// stable and the "Dolares" copy is category-level, not token-specific.
// The per-leg breakdown (with each leg's real sellToken) lives in
// `fromTokenAmounts[]`; the top-level outAmount is just for the row's
// primary label.
const AGGREGATE_OUT_TOKEN_ID =
  'celo-mainnet:0x765de816845861e75a25fca122bb6898b8b1282a'

// Squid Router on Celo. Approvals directed at this address DO NOT
// break the cluster - they are the setup step for a swap leg
// (`approve(SquidRouter, amount)` before `fundAndRunMulticall`).
// Wallet team spec 2026-08-28: "con approves intercalados permitidos".
// Same address hardcoded in `classifier.ts` KNOWN_AGGREGATOR_TARGETS;
// duplicated here because that module is not currently a value export
// and we do not want to add a new coupling for a two-line constant.
const SQUID_ROUTER_ADDRESS_LOWER =
  '0xce16f69375520ab01377ce7b88f5ba8c48f8d666'

// Cluster window measured from the newest-leg to the oldest-leg
// timestamp. Wallet spec: "<= 120 segundos entre primer y ultimo swap".
// Note: this bounds the whole cluster, not consecutive-pair diffs -
// two batches of multi-swaps 5 min apart do not collide because their
// windows are disjoint.
const CLUSTER_WINDOW_MS = 120_000

// Minimum cluster size that collapses. A singleton stays as-is.
const CLUSTER_MIN_SIZE = 2

function isClusterableSwap(tx: TokenTransaction): tx is SwapTransaction {
  if (tx.type !== 'SWAP_TRANSACTION') return false
  // Atomic 7702 already emits its own fromTokenAmounts[]. Do not
  // second-cluster it - the wallet already handles that path.
  if (tx.fromTokenAmounts && tx.fromTokenAmounts.length > 0) return false
  return DOLLAR_FAMILY_TOKEN_IDS.has(tx.outAmount.tokenId)
}

// Squid multi-swap sequences interleave `approve(SquidRouter, amount)`
// txs between the swap legs (one per leg the user has not previously
// approved). Such approvals do NOT break the cluster - they get
// re-emitted around the aggregated row at their original DESC
// position. Any non-Squid approval (or non-approval) DOES break the
// cluster since we cannot assume it belongs to the same user action.
function isSquidApproval(tx: TokenTransaction): tx is ApprovalTransaction {
  return (
    tx.type === 'APPROVAL' &&
    tx.approvedAddress.toLowerCase() === SQUID_ROUTER_ADDRESS_LOWER
  )
}

// Two swaps belong in the same cluster when they share the buy token
// (same "Pesos" output on both). Same-wallet is implicit because the
// feed handler already filters to one address per response. Same-Squid
// (`to`) is implicit because the classifier only emits SWAP_TRANSACTION
// for known aggregator targets OR single-pool routers; a
// dollar-family sellToken + shared buyToken combination is only
// produced by the Squid multi-swap Dolares path in practice.
function sharesClusterKey(a: SwapTransaction, b: SwapTransaction): boolean {
  return a.inAmount.tokenId === b.inAmount.tokenId
}

function withinClusterWindow(
  headTimestamp: number,
  candidateTimestamp: number,
): boolean {
  // `headTimestamp` is the newest (biggest) tx timestamp in the DESC-
  // sorted feed. As we walk older-and-older candidates, their
  // timestamps decrease; the window is exhausted when head - candidate
  // exceeds CLUSTER_WINDOW_MS.
  return headTimestamp - candidateTimestamp <= CLUSTER_WINDOW_MS
}

function sumDecimalStrings(values: readonly string[]): string {
  // Values are human-decimal strings (see TokenAmount.value contract),
  // NOT wei. Small counts (<= a few dozen legs per cluster in the worst
  // case) so a plain BigInt-fixed-precision sum is more than enough
  // precision-wise while avoiding Number-truncation on 18-decimal COPm.
  //
  // Convention: pick the max fractional-digits present in the inputs,
  // scale every value by 10^maxScale, sum in BigInt, then re-render.
  // If any input has no fractional part, treat as ".0" for the scale
  // calculation; if any is malformed, throw - we want a fail-loud on
  // bad classifier output rather than silently rendering "NaN" wallet-
  // side.
  let maxScale = 0
  for (const v of values) {
    const dot = v.indexOf('.')
    if (dot >= 0) {
      maxScale = Math.max(maxScale, v.length - dot - 1)
    }
  }
  const scale = BigInt(10) ** BigInt(maxScale)
  let acc = 0n
  for (const v of values) {
    const dot = v.indexOf('.')
    const intPart = dot >= 0 ? v.slice(0, dot) : v
    const fracPart = dot >= 0 ? v.slice(dot + 1) : ''
    const padded = fracPart.padEnd(maxScale, '0')
    acc += BigInt(intPart) * scale + BigInt(padded || '0')
  }
  if (maxScale === 0) return acc.toString()
  const asStr = acc.toString().padStart(maxScale + 1, '0')
  const intOut = asStr.slice(0, asStr.length - maxScale)
  const fracOut = asStr.slice(asStr.length - maxScale)
  return `${intOut}.${fracOut}`
}

function buildAggregatedSwap(cluster: readonly SwapTransaction[]): SwapTransaction {
  // `cluster[0]` is the newest leg (biggest timestamp) because the
  // feed feeds DESC. Wallet spec: "transactionHash: hash de la LAST tx
  // del cluster" - "last" in time = newest = cluster[0].
  const head = cluster[0]!

  const inValues = cluster.map((c) => c.inAmount.value)
  const outValues = cluster.map((c) => c.outAmount.value)

  const fromTokenAmounts: TokenAmount[] = cluster.map((c) => ({
    tokenId: c.outAmount.tokenId,
    value: c.outAmount.value,
    decimals: c.outAmount.decimals,
    transactionHash: c.transactionHash,
  }))

  // Aggregate fees: sum every SECURITY_FEE amount, denominated in
  // whatever tokenId the fee is in. Realistically all legs pay in the
  // same fee-currency (wallet picks one), so this collapses to a
  // single entry; we defensively bucket by tokenId to survive the rare
  // mixed case (e.g. one leg paid in CELO, another in COPm).
  const feeByToken = new Map<string, { decimals: number | null; values: string[] }>()
  for (const leg of cluster) {
    for (const f of leg.fees) {
      if (f.type !== 'SECURITY_FEE') continue
      const key = f.amount.tokenId
      const bucket = feeByToken.get(key)
      if (bucket) {
        bucket.values.push(f.amount.value)
      } else {
        feeByToken.set(key, { decimals: f.amount.decimals, values: [f.amount.value] })
      }
    }
  }
  const fees = Array.from(feeByToken.entries()).map(([tokenId, { decimals, values }]) => ({
    type: 'SECURITY_FEE' as const,
    amount: {
      tokenId,
      value: sumDecimalStrings(values),
      decimals,
    },
  }))

  // Pick the outAmount.tokenId defensively. When every leg sold the same
  // token, use that token. When the basket mixes (USDT + USDC + USDm),
  // pick the tokenId of the leg with the largest whole-unit value so any
  // future wallet renderer that reads `outAmount.tokenId` (today it uses
  // `fromTokenAmounts`) sees a token that was ACTUALLY sold instead of a
  // hardcoded USDm. Falls back to AGGREGATE_OUT_TOKEN_ID only when the
  // cluster is somehow empty (unreachable in practice).
  const uniqueTokenIds = new Set(cluster.map((c) => c.outAmount.tokenId))
  let dominantTokenId: string
  let dominantDecimals: number | null
  if (uniqueTokenIds.size === 1) {
    dominantTokenId = cluster[0]!.outAmount.tokenId
    dominantDecimals = cluster[0]!.outAmount.decimals
  } else {
    const largest = cluster.reduce((a, b) =>
      Number(b.outAmount.value) > Number(a.outAmount.value) ? b : a,
    )
    dominantTokenId = largest.outAmount.tokenId
    dominantDecimals = largest.outAmount.decimals
  }
  return {
    ...head,
    inAmount: {
      tokenId: head.inAmount.tokenId,
      value: sumDecimalStrings(inValues),
      decimals: head.inAmount.decimals,
    },
    outAmount: {
      tokenId: dominantTokenId,
      value: sumDecimalStrings(outValues),
      decimals: dominantDecimals,
    },
    fromTokenAmounts,
    fees,
  }
}

// Public entrypoint. Called from the /api/transactions/feed handler
// after classification, before enrichment. Preserves DESC ordering
// (newest first).
export function clusterMultiDollarSwaps(
  txs: readonly TokenTransaction[],
): TokenTransaction[] {
  const out: TokenTransaction[] = []
  let i = 0
  while (i < txs.length) {
    const current = txs[i]!
    if (!isClusterableSwap(current)) {
      out.push(current)
      i++
      continue
    }
    const cluster: SwapTransaction[] = [current]
    const approvalsInSequence: ApprovalTransaction[] = []
    const head = current
    let j = i + 1
    while (j < txs.length) {
      const next = txs[j]!
      // Squid approvals interleave with legs in the legacy sequential
      // flow. Absorb them so the swap on the far side of the approval
      // still joins the cluster; the approvals themselves are re-
      // emitted after the aggregate at their original DESC position.
      if (isSquidApproval(next)) {
        approvalsInSequence.push(next)
        j++
        continue
      }
      if (!isClusterableSwap(next)) break
      if (!sharesClusterKey(head, next)) break
      if (!withinClusterWindow(head.timestamp, next.timestamp)) break
      cluster.push(next)
      j++
    }
    if (cluster.length >= CLUSTER_MIN_SIZE) {
      out.push(buildAggregatedSwap(cluster))
      // Preserve the DESC order of the approvals; they were already
      // in DESC order in the input because we walked newest-first.
      out.push(...approvalsInSequence)
    } else {
      // Not a cluster: emit the singleton swap + any approvals we
      // consumed. Order matches the input (swap first because it
      // was the newest, then approvals in DESC order).
      out.push(current)
      out.push(...approvalsInSequence)
    }
    i = j
  }
  return out
}

export const _testExports = {
  DOLLAR_FAMILY_TOKEN_IDS,
  AGGREGATE_OUT_TOKEN_ID,
  CLUSTER_WINDOW_MS,
  CLUSTER_MIN_SIZE,
  sumDecimalStrings,
}
