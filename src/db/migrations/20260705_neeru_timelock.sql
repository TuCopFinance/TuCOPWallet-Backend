-- Defense-in-depth monitor for the Timelock that guards the V1 fund proxy.
-- Neeru's proxy admin is a Timelock controller; every upgradeToAndCall goes
-- through schedule() first with a 48h delay. This table captures each
-- schedule / execute / cancel event that targets the proxy so operators can
-- react within the delay window if an unexpected upgrade lands.
--
-- Only rows where the Timelock target equals the tracked contract address
-- (env NEERU_CONTRACT_ADDRESS at ingest time) are persisted; other operations
-- on the same Timelock are ignored.

CREATE TABLE neeru_upgrade_events (
  event_id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'executed', 'cancelled')),
  operation_id TEXT NOT NULL,
  target TEXT,
  value NUMERIC(78, 0),
  calldata TEXT,
  predecessor TEXT,
  delay BIGINT,
  ready_ts BIGINT,
  block_number BIGINT NOT NULL,
  block_timestamp BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tx_hash, log_index)
);

CREATE INDEX idx_neeru_upgrade_events_operation
  ON neeru_upgrade_events(operation_id);
CREATE INDEX idx_neeru_upgrade_events_kind_block
  ON neeru_upgrade_events(kind, block_number);

CREATE TABLE neeru_timelock_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_scanned_block BIGINT NOT NULL,
  last_scan_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  last_error_at TIMESTAMPTZ
);
