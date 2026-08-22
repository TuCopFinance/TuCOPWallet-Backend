import { fetchWithTimeout } from './http'
import { createLogger } from './logger'
import { squidUpstreamOutcomeTotal } from './metrics'
import { Sentry } from './sentry'

const log = createLogger('lib:squid')

const SQUID_ROUTE_URL = 'https://apiplus.squidrouter.com/v2/route'

// Circuit breaker for the shared Squid upstream. Same pattern as
// `priceProviders.ts` and `celoRpcFallback.ts`: after N consecutive
// upstream failures, short-circuit subsequent calls with a synthetic
// 502 for `SKIP_DURATION_MS` so the request queue does not pay the
// 8s per-call timeout while Squid is 500-sustained. A single success
// resets the counter. When the breaker is OPEN the caller sees
// `SquidUpstreamError(502)` immediately; the existing shapeResponse
// error path (which already falls through to the Uniswap V4 fallback
// for USDT<->COPm) handles it transparently.
const BREAKER_SKIP_AFTER_FAILURES = 5
const BREAKER_SKIP_DURATION_MS = 30 * 1000
interface BreakerState {
  consecutiveFailures: number
  skipUntilMs: number | null
}
const breaker: BreakerState = { consecutiveFailures: 0, skipUntilMs: null }

function isBreakerOpen(): boolean {
  if (breaker.skipUntilMs == null) return false
  if (Date.now() >= breaker.skipUntilMs) {
    breaker.skipUntilMs = null
    breaker.consecutiveFailures = 0
    return false
  }
  return true
}

function recordFailure(): void {
  breaker.consecutiveFailures += 1
  if (breaker.consecutiveFailures === BREAKER_SKIP_AFTER_FAILURES) {
    // First-cross: fire ONE Sentry event per open-window so alerts ring
    // exactly once when Squid degrades, not per subsequent short-circuited
    // request. Recovery resets consecutiveFailures to 0 (via
    // recordSuccess) and primes the next crossing.
    breaker.skipUntilMs = Date.now() + BREAKER_SKIP_DURATION_MS
    log.warn(
      `squid circuit breaker open for ${BREAKER_SKIP_DURATION_MS}ms after ${breaker.consecutiveFailures} consecutive failures`,
    )
    Sentry.captureMessage('squid_breaker_opened', {
      level: 'error',
      tags: {
        event: 'squid_breaker_opened',
        provider: 'squid',
      },
      extra: {
        consecutiveFailures: breaker.consecutiveFailures,
        skipDurationMs: BREAKER_SKIP_DURATION_MS,
        skipUntilMs: breaker.skipUntilMs,
      },
    })
  }
}

function recordSuccess(): void {
  breaker.consecutiveFailures = 0
  breaker.skipUntilMs = null
}

export function _resetSquidBreakerForTests(): void {
  breaker.consecutiveFailures = 0
  breaker.skipUntilMs = null
}

export class SquidUpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter?: string,
    public readonly bodyHint?: string,
  ) {
    super(
      bodyHint
        ? `Squid upstream ${status}: ${bodyHint}`
        : `Squid upstream ${status}`,
    )
    this.name = 'SquidUpstreamError'
  }
}

// Squid's `collectFees` structure per https://docs.squidrouter.com/collect-fees.
// When present, Squid deducts feeValue% from the output token BEFORE returning
// the route + transaction, and routes that amount on-chain to integratorAddress
// as part of the swap execution. Feature-flagged via ENABLE_SQUID_INTEGRATOR_FEES
// in env.ts so the block below only ships to Squid when explicitly enabled.
export interface SquidCollectFees {
  integratorAddress: `0x${string}`
  feeType: 'percentage'
  feeValue: number
}

export interface SquidRouteRequest {
  fromAddress: string
  fromChain: string
  fromToken: string
  fromAmount: string
  toChain: string
  toToken: string
  toAddress: string
  slippage: number
  quoteOnly: boolean
  // Optional. Omitted from JSON.stringify body when undefined (viem-style)
  // so the wire shape stays identical to today when the feature flag is off.
  collectFees?: SquidCollectFees
}

interface SquidFeeCost {
  amount?: string
  name?: string
}

interface SquidGasCost {
  amount?: string
  limit?: string
}

export interface SquidRouteResponse {
  route: {
    estimate: {
      fromAmount?: string
      toAmount?: string
      toAmountMin?: string
      exchangeRate?: string
      aggregatePriceImpact?: string
      estimatedRouteDuration?: number
      feeCosts?: SquidFeeCost[]
      gasCosts?: SquidGasCost[]
      // Squid echoes the integrator fee percentage back as a string decimal
      // (e.g. "0.5" for 0.5%) when collectFees was in the request AND was
      // successfully applied to the route. Absent when collectFees was not
      // sent OR the route could not honor it (e.g. the underlying protocol
      // does not support integrator fees for that hop). See the wallet's
      // per-quote docs comment in useMultiSwapQuote.ts for the convention.
      appFeePercentageIncludedInPrice?: string
    }
    transactionRequest: {
      target?: string
      data?: string
      value?: string
      gasLimit?: string
      from?: string
    }
  }
}

export async function squidRoute(
  body: SquidRouteRequest,
  integratorId: string,
): Promise<SquidRouteResponse> {
  if (isBreakerOpen()) {
    squidUpstreamOutcomeTotal.labels({ outcome: 'breaker_open' }).inc()
    throw new SquidUpstreamError(502, undefined, 'circuit breaker open')
  }
  return Sentry.startSpan(
    {
      name: 'squid.route',
      op: 'http.client',
      attributes: {
        provider: 'squid',
        fromChain: body.fromChain,
        toChain: body.toChain,
      },
    },
    async () => {
      let res: Response
      try {
        res = await fetchWithTimeout(SQUID_ROUTE_URL, {
          method: 'POST',
          headers: {
            'x-integrator-id': integratorId,
            'Content-Type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        recordFailure()
        const errName = err instanceof Error ? err.name : 'unknown'
        squidUpstreamOutcomeTotal
          .labels({ outcome: errName === 'AbortError' ? 'timeout' : 'other' })
          .inc()
        throw err
      }
      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after') ?? undefined
        let bodyHint: string | undefined
        try {
          const text = await res.text()
          bodyHint = text.length > 200 ? `${text.slice(0, 200)}...` : text
        } catch {
          // body unreadable; status alone is enough
        }
        // 429 is a rate-limit pass-through, not a service outage; do NOT
        // trip the breaker on it (the caller may retry, or another wallet
        // may succeed immediately). 5xx counts toward the breaker.
        if (res.status >= 500) recordFailure()
        const outcome =
          res.status === 429 ? '429' : res.status >= 500 ? '5xx' : 'other'
        squidUpstreamOutcomeTotal.labels({ outcome }).inc()
        throw new SquidUpstreamError(res.status, retryAfter, bodyHint)
      }
      recordSuccess()
      squidUpstreamOutcomeTotal.labels({ outcome: 'ok' }).inc()
      return (await res.json()) as SquidRouteResponse
    },
  )
}
