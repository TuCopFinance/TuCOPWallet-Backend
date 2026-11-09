// Inbound TuCOPRamp webhook receiver (`POST /api/tucopramp/webhooks/p2p`).
//
// Counterpart to the outbound proxy in tucopramp-proxy.ts: this direction is
// TuCOPRamp calling us. It is NOT part of the proxy allowlist, it never
// forwards anything upstream, and the proxy kill switch does not gate it --
// turning the ramp off should not start throwing away the notices for orders
// that are already open.
//
// Registered in the TuCOPRamp console under the `p2p` notice category, which
// is a separate endpoint from the `on_off_ramp` one. The only event the
// category carries today is `p2p_order.updated`, one per status change of a
// P2P order, on-ramp or off-ramp.
//
// Signature (Standard Webhooks, https://www.standardwebhooks.com). The easy
// thing to get wrong is assuming only the body is signed:
//
//   signed content = `<webhook-id>.<webhook-timestamp>.<raw body>`
//   HMAC key       = base64decode(secret without the `whsec_` prefix), bytes
//   header         = webhook-signature: v1,<base64 HMAC-SHA256>
//
// During a secret rotation the header carries one signature per secret,
// space separated, and the request is good if ANY of them matches. The
// official `standardwebhooks` package does all of that, plus the constant-
// time compare and the 5-minute timestamp window, so we do not hand-roll it.
// The raw bytes matter: this route must see the body before any JSON parser
// touches it, which is why it mounts its own `express.raw()` and is mounted
// ahead of the app-wide `express.json()`.
//
// Status codes, and why each one:
//
// - 200 for anything authentic. Includes event types we do not handle (the
//   `ping` test event is delivered whatever the category filter says) and an
//   authentic body whose shape we did not expect. TuCOPRamp pauses an
//   endpoint after consecutive failures and disables it outright after three
//   days without a success, so answering 4xx to an authentic delivery would
//   eventually cost us every event, including the good ones. We record and
//   alert instead. Never 410 from here: upstream reads 410 as "this endpoint
//   is gone" and disables it immediately.
// - 401 for anything that is not authentic: bad or missing signature
//   headers, a signature that matches no secret, a timestamp outside the
//   5-minute window.
// - 503 when WE cannot do our job -- the secret is unset or unusable, or the
//   event store is unreachable. This is the one case where upstream's retry
//   is doing exactly what we want: it holds the event until we are fixed.
//   The alternative, a 200 we cannot honour, loses the event silently.
//
// Idempotency is on `external_ref`, built from order_id + status +
// updated_at. See the migration (20261109_tucopramp_webhook_events.sql) for
// why order_id + status alone is wrong.
//
// Secret handling: `TUCOPRAMP_WEBHOOK_SECRET_P2P` is never logged, never
// attached to a Sentry event, and never echoed in a response.

import express from 'express'
import { Router, type Request, type Response } from 'express'
import { Webhook } from 'standardwebhooks'
import { getDb } from '../lib/db'
import { env } from '../lib/env'
import { createLogger } from '../lib/logger'
import { tucoprampWebhookEventsTotal } from '../lib/metrics'
import { Sentry } from '../lib/sentry'

const log = createLogger('routes:tucopramp-webhooks')

const router = Router()

export const WEBHOOK_PATH = '/api/tucopramp/webhooks/p2p'

const P2P_ORDER_UPDATED = 'p2p_order.updated'
// Same 10 MB ceiling as the proxy. A notice body is a few hundred bytes; the
// limit is only here so an oversized request is rejected before we buffer it.
const MAX_BODY_BYTES = 10 * 1024 * 1024

// The delivered body is an ENVELOPE, not the order payload on its own. The
// order fields live under `data`:
//
//   { "id": "evt_...", "type": "p2p_order.updated", "category": "p2p",
//     "timestamp": "<ISO>", "api_version": "<...>",
//     "data": { "order_id", "kind", "status", "tx_hash",
//               "refund_tx_hash", "updated_at" } }
//
// `id` is also the `webhook-id` header and is stable across retries.
interface WebhookEnvelope {
  id?: unknown
  type?: unknown
  data?: unknown
}

interface OrderUpdate {
  orderId: string
  kind: string
  status: string
  updatedAt: string
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

// The four fields we persist. `tx_hash` / `refund_tx_hash` are deliberately
// not stored: the order's own GET is the source of truth for them, and this
// table exists to answer "what changed, and when".
function parseOrderUpdate(data: unknown): OrderUpdate | null {
  if (typeof data !== 'object' || data === null) return null
  const row = data as Record<string, unknown>
  const orderId = readString(row, 'order_id')
  const kind = readString(row, 'kind')
  const status = readString(row, 'status')
  const updatedAt = readString(row, 'updated_at')
  if (!orderId || !kind || !status || !updatedAt) return null
  if (Number.isNaN(Date.parse(updatedAt))) return null
  return { orderId, kind, status, updatedAt }
}

router.use(WEBHOOK_PATH, express.raw({ type: '*/*', limit: MAX_BODY_BYTES }))

router.post(WEBHOOK_PATH, async (req: Request, res: Response) => {
  const secret = env.TUCOPRAMP_WEBHOOK_SECRET_P2P
  if (!secret) {
    Sentry.captureMessage('tucopramp_webhook_secret_missing', {
      level: 'error',
      tags: { event: 'tucopramp_webhook_secret_missing' },
    })
    log.warn('webhook rejected: TUCOPRAMP_WEBHOOK_SECRET_P2P is not set')
    return res.status(503).json({ code: 'webhook_not_configured' })
  }

  let verifier: Webhook
  try {
    verifier = new Webhook(secret)
  } catch {
    // Wrong shape for the secret (not `whsec_<base64>`): operator error, and
    // only the failure is reported, never the value.
    Sentry.captureMessage('tucopramp_webhook_secret_unusable', {
      level: 'error',
      tags: { event: 'tucopramp_webhook_secret_unusable' },
    })
    log.warn('webhook rejected: TUCOPRAMP_WEBHOOK_SECRET_P2P is not a usable secret')
    return res.status(503).json({ code: 'webhook_not_configured' })
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  try {
    verifier.verify(
      rawBody,
      {
        'webhook-id': req.header('webhook-id') ?? '',
        'webhook-timestamp': req.header('webhook-timestamp') ?? '',
        'webhook-signature': req.header('webhook-signature') ?? '',
      },
      // Parse the body ourselves below so a shape we did not expect is an
      // alert rather than a thrown verification error.
      { jsonParse: false },
    )
  } catch {
    log.warn('webhook rejected: signature did not verify')
    return res.status(401).json({ code: 'signature_invalid' })
  }

  // Authentic from here on. Every exit is 200 unless WE failed.
  let envelope: WebhookEnvelope
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    envelope = parsed as WebhookEnvelope
  } catch {
    Sentry.captureMessage('tucopramp_webhook_unparseable', {
      level: 'warning',
      tags: { event: 'tucopramp_webhook_unparseable' },
    })
    log.warn('webhook accepted but body is not a JSON object')
    tucoprampWebhookEventsTotal.inc({ type: 'unknown', outcome: 'ignored' })
    return res.status(200).json({ received: true })
  }

  const type = typeof envelope.type === 'string' ? envelope.type : 'unknown'
  if (type !== P2P_ORDER_UPDATED) {
    // `ping` lands here, by design: it is the console's test delivery and is
    // sent whatever the category filter says.
    log.info(`webhook accepted, type not handled: ${type}`)
    tucoprampWebhookEventsTotal.inc({ type, outcome: 'ignored' })
    return res.status(200).json({ received: true })
  }

  const update = parseOrderUpdate(envelope.data)
  if (!update) {
    Sentry.captureMessage('tucopramp_webhook_payload_unexpected', {
      level: 'warning',
      tags: { event: 'tucopramp_webhook_payload_unexpected' },
      extra: { type },
    })
    log.warn(`webhook accepted but ${type} payload is missing required fields`)
    tucoprampWebhookEventsTotal.inc({ type, outcome: 'ignored' })
    return res.status(200).json({ received: true })
  }

  const externalRef = `${P2P_ORDER_UPDATED}:${update.orderId}:${update.status}:${update.updatedAt}`

  const db = getDb()
  if (!db) {
    Sentry.captureMessage('tucopramp_webhook_storage_unavailable', {
      level: 'error',
      tags: { event: 'tucopramp_webhook_storage_unavailable' },
    })
    log.warn('webhook deferred: no database configured, asking upstream to retry')
    return res.status(503).json({ code: 'webhook_storage_unavailable' })
  }

  let inserted: boolean
  try {
    const result = await db.query(
      `INSERT INTO tucopramp_webhook_events
         (external_ref, order_id, kind, status, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (external_ref) DO NOTHING`,
      [externalRef, update.orderId, update.kind, update.status, update.updatedAt],
    )
    inserted = (result.rowCount ?? 0) > 0
  } catch (err) {
    // A failed write means the event is NOT recorded, so the retry is wanted.
    Sentry.captureException(err, {
      tags: { event: 'tucopramp_webhook_persist_failed' },
      extra: { order_id: update.orderId, status: update.status },
    })
    log.error(
      `webhook persist failed for ${update.orderId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return res.status(503).json({ code: 'webhook_storage_unavailable' })
  }

  // Audit trail, at warn so it survives the production log level. No personal
  // data: the event itself is thin on purpose (no name, document, bank or
  // Bre-B key).
  log.warn(
    JSON.stringify({
      event: 'tucopramp_webhook_received',
      type,
      order_id: update.orderId,
      kind: update.kind,
      status: update.status,
      updated_at: update.updatedAt,
      outcome: inserted ? 'stored' : 'duplicate',
    }),
  )
  tucoprampWebhookEventsTotal.inc({ type, outcome: inserted ? 'stored' : 'duplicate' })

  return res.status(200).json({ received: true })
})

export default router
