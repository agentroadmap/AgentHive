-- ============================================================================
-- Rollback for 316-p4509-operator-granular-control-backfill.sql
-- ----------------------------------------------------------------------------
-- P4509 AC-7 rollback contract: restore the OLD handler authorization
-- (legacy `control.stop` check on all five endpoints) WITHOUT deleting the
-- granular grants that were added by the backfill.
--
-- HOW THE CUTOVER FLIPS BACK
-- --------------------------
-- The granular handler authorization in code is gated on the presence of the
-- backfill migration row in roadmap.schema_migration
-- (see operator-actions.ts isGranularControlCutoverEnabled). Removing that
-- ledger row makes the handlers fall back to `control.stop` — i.e. the exact
-- pre-P4509 behavior. The added granular actions on existing tokens are
-- harmless supersets and are intentionally LEFT IN PLACE (deleting them would
-- be a destructive, irreversible mutation of operator credentials and is
-- explicitly forbidden by AC-7).
--
-- Operators who want an INSTANT rollback without touching the ledger can
-- instead set AGENTHIVE_P4509_GRANULAR_DISABLE=1 in the server environment;
-- this rollback file is the durable, ledger-level revert.
--
-- This rollback is idempotent. It does NOT modify roadmap.operator_token.
-- ============================================================================

BEGIN;

-- Flip the cutover gate back off by removing the canonical ledger row.
DELETE FROM roadmap.schema_migration
 WHERE filename = '316-p4509-operator-granular-control-backfill.sql';

-- (Defensive) also clear the secondary history ledger row if one was written.
DELETE FROM roadmap.migration_history
 WHERE filename = '316-p4509-operator-granular-control-backfill.sql';

-- Audit the rollback. Granular grants are deliberately retained.
INSERT INTO roadmap.operator_audit_log
    (operator_name, token_id, action, decision,
     target_kind, target_identity, request_summary, response_status, failure_reason)
VALUES
    ('migration:316-p4509-rollback', NULL, 'token.backfill.rollback', 'allow',
     'operator_token', 'cutover-disabled',
     jsonb_build_object(
        'migration', '316-p4509-operator-granular-control-backfill.sql',
        'note', 'ledger row removed; granular grants retained per AC-7'
     ),
     200, NULL);

COMMIT;

-- NOTE: roadmap.operator_token.allowed_actions is intentionally untouched.
-- The granular actions remain on the tokens; the handlers simply stop checking
-- them and revert to control.stop until the migration is re-applied.
