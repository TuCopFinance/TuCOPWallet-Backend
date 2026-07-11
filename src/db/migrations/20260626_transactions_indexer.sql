-- Transaction Feed Indexer schema (WRI Track C, Phase 1).

CREATE TABLE IF NOT EXISTS indexer_state (
  network_id   text PRIMARY KEY,
  last_block   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS watched_address (
  address                text PRIMARY KEY,
  added_at               timestamptz NOT NULL DEFAULT now(),
  backfill_started_at    timestamptz,
  backfill_completed_at  timestamptz
);

CREATE TABLE IF NOT EXISTS tx (
  id                  bigserial PRIMARY KEY,
  network_id          text NOT NULL,
  tx_hash             text NOT NULL,
  block_number        bigint NOT NULL,
  block_timestamp     timestamptz NOT NULL,
  tx_index            int NOT NULL,
  from_address        text NOT NULL,
  to_address          text,
  value_wei           numeric NOT NULL,
  tx_type             text NOT NULL,
  status              text NOT NULL,
  gas_used            bigint,
  effective_gas_price numeric,
  fee_currency        text,
  raw_input           text NOT NULL,
  UNIQUE (network_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS tx_from_block_idx
  ON tx (network_id, from_address, block_number DESC, tx_index DESC);

CREATE INDEX IF NOT EXISTS tx_to_block_idx
  ON tx (network_id, to_address, block_number DESC, tx_index DESC);

CREATE TABLE IF NOT EXISTS tx_log (
  id        bigserial PRIMARY KEY,
  tx_id     bigint NOT NULL REFERENCES tx(id) ON DELETE CASCADE,
  log_index int NOT NULL,
  contract  text NOT NULL,
  topic0    text NOT NULL,
  topic1    text,
  topic2    text,
  topic3    text,
  data      text NOT NULL,
  UNIQUE (tx_id, log_index)
);

CREATE INDEX IF NOT EXISTS tx_log_tx_idx ON tx_log (tx_id);

CREATE TABLE IF NOT EXISTS classified_tx_cache (
  network_id    text NOT NULL,
  tx_hash       text NOT NULL,
  user_address  text NOT NULL,
  payload_json  jsonb NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, tx_hash, user_address)
);
