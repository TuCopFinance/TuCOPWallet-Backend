-- Backfill progress checkpoint columns. Enables durable resume across
-- process restarts + interleaved persist per chunk, so a Cloudflare 1015
-- against Forno (or any other transient RPC failure) does not throw away
-- the chunks that already landed on disk.
--
-- backfill_cursor_block: next block to scan. Initialized on first /watch
--                       call to (tip - depth). Advances by LOG_BATCH_BLOCKS
--                       at the end of every successful chunk transaction.
-- backfill_end_block:   snapped upper bound at init time. Backfill stops
--                       (marks backfill_completed_at) when cursor > end.
-- backfill_last_error / backfill_last_attempt_at: last transient failure
--                       for operator visibility (Sentry-lite). Not fatal.

ALTER TABLE watched_address
  ADD COLUMN IF NOT EXISTS backfill_cursor_block bigint,
  ADD COLUMN IF NOT EXISTS backfill_end_block bigint,
  ADD COLUMN IF NOT EXISTS backfill_last_error text,
  ADD COLUMN IF NOT EXISTS backfill_last_attempt_at timestamptz;

-- Boot-time resume picks up rows here: backfill in progress AND cursor set
-- AND completed timestamp still null.
CREATE INDEX IF NOT EXISTS watched_address_backfill_pending_idx
  ON watched_address (backfill_cursor_block)
  WHERE backfill_completed_at IS NULL
    AND backfill_cursor_block IS NOT NULL;
