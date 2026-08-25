-- Follow-up to 20260825_neeru_widen_category_check.sql. The prior migration
-- widened the CHECK from {0,1,2,3} to {0..5} to accept the tranche indices
-- added on the 2026-08-05 governance upgrade. That widening is still a
-- hardcoded upper bound and would re-block the indexer if the contract
-- adds a 7th index later. Relax the constraint to the full uint8 range so
-- the source-of-truth stays on-chain (TRANCHE_COUNT() at read time,
-- isNeeruCategory guard at write time).

ALTER TABLE neeru_positions
  DROP CONSTRAINT neeru_positions_category_check;

ALTER TABLE neeru_positions
  ADD CONSTRAINT neeru_positions_category_check
  CHECK (category >= 0 AND category <= 255);
