CREATE TABLE neeru_positions (
  position_id NUMERIC(78, 0) PRIMARY KEY,
  user_address TEXT NOT NULL,
  category SMALLINT NOT NULL CHECK (category IN (0,1,2,3)),
  amount NUMERIC(78, 0) NOT NULL,
  start_ts BIGINT NOT NULL,
  end_ts BIGINT NOT NULL,
  deposit_block BIGINT NOT NULL,
  deposit_tx_hash TEXT NOT NULL,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at_ts BIGINT,
  closed_block BIGINT,
  closed_tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_neeru_positions_user ON neeru_positions(user_address);
CREATE INDEX idx_neeru_positions_open ON neeru_positions(user_address, closed) WHERE NOT closed;
CREATE INDEX idx_neeru_positions_category ON neeru_positions(user_address, category, closed) WHERE NOT closed;

CREATE TABLE neeru_indexer_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_scanned_block BIGINT NOT NULL,
  last_scan_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  last_error_at TIMESTAMPTZ
);
