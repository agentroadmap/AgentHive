-- ============================================================================
-- ROLLBACK: Migration 310 — P4668 dual-write shim
-- ============================================================================
-- Safe to run when migs 311-313 have NOT been applied.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS roadmap_proposal.v_dual_write_divergence;

DROP TRIGGER IF EXISTS trg_shadow_write_to_ledger ON roadmap_proposal.proposal_state_transitions;
DROP FUNCTION IF EXISTS roadmap.fn_shadow_write_to_ledger();

REVOKE EXECUTE ON FUNCTION roadmap.fn_p4668_backfill_history(BOOLEAN, INTEGER)
    FROM claude, agent_write;
DROP FUNCTION IF EXISTS roadmap.fn_p4668_backfill_history(BOOLEAN, INTEGER);

COMMIT;
