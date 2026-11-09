-- Inbound TuCOPRamp p2p_order.updated webhook events.
--
-- Receipt log for the notices TuCOPRamp sends on every P2P order status
-- change, so the wallet surface stops depending on polling and we keep a
-- history we can reconcile against. Consumption (a push notification to the
-- user) is separate work: it needs the push token, which lives in the wallet.
--
-- external_ref is the primary key, and it is deliberately built from
-- order_id + status + updated_at rather than order_id + status. An order can
-- return to a status it already had: a rejected proof sent again with
-- outcome `retry` puts the order back to AWAITING_PROOF, and TuCOPRamp
-- announces it again. Deduplicating on order_id + status would swallow that
-- second notice and the order would sit frozen in the UI. The same key makes
-- a TuCOPRamp delivery retry a no-op, which is the other half of what it is
-- for. It mirrors the external_ref upstream builds for the same event.
--
-- The (order_id, updated_at DESC) index serves the read that matters: the
-- current state of one order is its most recent event, and events can arrive
-- out of order.

CREATE TABLE IF NOT EXISTS tucopramp_webhook_events (
  external_ref TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tucopramp_webhook_events_order_updated_idx
  ON tucopramp_webhook_events (order_id, updated_at DESC);
