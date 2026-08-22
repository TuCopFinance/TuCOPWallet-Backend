import * as Sentry from '@sentry/node'
import { createLogger } from './logger'

const log = createLogger('lib:sentry')

let initialized = false

// URLs where the SDK should NOT create a session / transaction. Railway
// probes /health and /ready every few seconds; without this filter the
// session data (release health dashboard) is 99%+ health-probe noise and
// any actual user session gets buried. /metrics is similar: Prometheus
// scrape endpoint hit by external monitors, not user traffic.
const PROBE_ROUTES = new Set(['/health', '/api/health', '/ready', '/api/ready', '/metrics'])

// Upstream provider errors carry a `.provider` + `.status` tag so Sentry
// fingerprints them into per-provider groups (cmc_500, coingecko_429,
// squid_502, forno_1015) instead of merging into one giant "fetch failed"
// issue. Producers set the fields via `attachUpstreamMeta` below.
interface UpstreamError extends Error {
  provider?: string
  status?: number | string
  code?: string
}

// Attach provider + status to an error before rethrowing so `beforeSend`
// can fingerprint it. Producers (priceProviders, squid, blockscout, ...)
// call this on the caught upstream error path.
export function attachUpstreamMeta<E extends Error>(
  err: E,
  provider: string,
  status: number | string | undefined,
): E {
  const e = err as UpstreamError
  e.provider = provider
  if (status !== undefined) e.status = status
  return err
}

// Initialise Sentry exactly once at process boot. No-op when SENTRY_DSN is
// unset, so dev / local runs do not need a real Sentry project.
//
// Called from src/server.ts BEFORE any Express middleware is registered so
// the SDK can patch http and async-context hooks for full request tracing.
export function initSentry(): void {
  if (initialized) return
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    log.info('SENTRY_DSN not set; Sentry disabled')
    initialized = true
    return
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA ?? undefined,
    // Sampling. Default 0.1 (10%) for performance traces, 1.0 for errors.
    // Free tier on Sentry handles ~5k events/month; this lets a busy day
    // (~50k requests) stay within budget without losing the error signal.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    integrations: [
      // Skip session + transaction creation on Railway health probes so
      // /health, /ready, /metrics do not saturate release-health
      // dashboards or push up transaction volume.
      Sentry.httpIntegration({
        ignoreIncomingRequests: (url: string): boolean => {
          try {
            const path = new URL(url, 'http://x').pathname
            return PROBE_ROUTES.has(path)
          } catch {
            return false
          }
        },
      }),
    ],
    beforeSend(event, hint) {
      // Drop noise from expected timeout / abort paths. The waterfall's
      // next-tier retry already handles these; capturing them as issues
      // would flood the tray with non-actionable events.
      const err = hint?.originalException as UpstreamError | undefined
      const errName = err?.name ?? ''
      if (errName === 'AbortError' || errName === 'TimeoutError') return null
      if (err?.code === 'ECONNRESET') return null

      // Custom fingerprinting for upstream provider errors: group by
      // [provider, status] so per-provider degradations stay distinct.
      // Requires the throwing code to tag the error with `.provider` +
      // `.status` (via `attachUpstreamMeta`). Silent fallback when unset
      // so events that lack the tags still group by Sentry defaults.
      if (err?.provider && err?.status !== undefined) {
        event.fingerprint = ['upstream', err.provider, String(err.status)]
      }

      // Sanitize known-secret query params before sending to Sentry.
      // The proxy routes strip these server-side, but if anything leaks
      // through a future code path it should not land on Sentry's servers.
      if (event.request?.query_string) {
        const qs = String(event.request.query_string)
        if (/(apikey|api_key|secret|token|pk)=/i.test(qs)) {
          event.request.query_string = '<redacted>'
        }
      }
      return event
    },
  })
  initialized = true
  log.info(`Sentry initialized (environment=${process.env.NODE_ENV ?? 'development'})`)
}

// Re-export the namespace so callers can use `import { Sentry } from
// './lib/sentry'` and call `Sentry.captureException(err)` etc. The
// Sentry SDK no-ops gracefully when not initialized.
export { Sentry }

export function _resetSentryForTests(): void {
  initialized = false
}
