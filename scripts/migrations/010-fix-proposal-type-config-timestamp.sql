-- 010-fix-proposal-type-config-timestamp.sql
-- Description: Rename modified_at → updated_at on proposal_type_config
-- Date: 2026-04-07
-- Requires: roadmap schema live
--
-- Fixes: fn_set_updated_at() trigger sets NEW.updated_at but proposal_type_config
-- uses modified_at as its timestamp column. Any UPDATE (including ON CONFLICT DO UPDATE
-- in seeds) throws: "record new has no field updated_at".
-- All other tables in the schema use updated_at — this renames for consistency.

BEGIN;

ALTER TABLE roadmap.proposal_type_config
  RENAME COLUMN modified_at TO updated_at;

-- Update the trigger name to match the corrected semantics (cosmetic, not functional)
DROP TRIGGER IF EXISTS trg_proposal_type_config_updated_at ON roadmap.proposal_type_config;

CREATE TRIGGER trg_proposal_type_config_updated_at
  BEFORE UPDATE ON roadmap.proposal_type_config
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

COMMIT;
