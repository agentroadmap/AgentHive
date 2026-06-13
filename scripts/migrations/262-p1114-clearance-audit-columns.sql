-- P1114: tiered clearance for MCP tools — audit-log extension.
--
-- Adds the clearance-decision context to control_identity.auth_decision_log so a
-- tier violation records WHY it was allowed/denied. All columns nullable +
-- IF NOT EXISTS → idempotent and backward-compatible with existing P843 rows.

BEGIN;

ALTER TABLE control_identity.auth_decision_log ADD COLUMN IF NOT EXISTS scope         TEXT;
ALTER TABLE control_identity.auth_decision_log ADD COLUMN IF NOT EXISTS tier_required TEXT;
ALTER TABLE control_identity.auth_decision_log ADD COLUMN IF NOT EXISTS tier_actual   TEXT;
ALTER TABLE control_identity.auth_decision_log ADD COLUMN IF NOT EXISTS reason        TEXT;

COMMIT;
