import * as Sentry from '@sentry/node'
import { createLogger } from './logger'

const log = createLogger('lib:sentry')

let initialized = false

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
    // Sanitize known-secret query params before sending to Sentry.
    // The proxy routes strip these server-side, but if anything leaks
    // through a future code path it should not land on Sentry's servers.
    beforeSend(event) {
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
