-- Neeru contract added 2 more tranche indices (post-2026-08-05 governance
-- upgrade). The original migration hardcoded the accepted category set to
-- {0,1,2,3} via a CHECK constraint. Widen it to {0..5} so the indexer can
-- insert rows for the new categories. Source-side widening lives in
-- src/neeru-indexer/types.ts (NeeruCategory) and parser.ts (isNeeruCategory).

ALTER TABLE neeru_positions
  DROP CONSTRAINT neeru_positions_category_check;

ALTER TABLE neeru_positions
  ADD CONSTRAINT neeru_positions_category_check
  CHECK (category IN (0, 1, 2, 3, 4, 5));
