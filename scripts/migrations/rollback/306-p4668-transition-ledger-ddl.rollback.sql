-- ============================================================================
-- ROLLBACK: Migration 306 — P4668 transition ledger DDL
-- ============================================================================
-- Safe to run when migs 307-313 have NOT been applied.
-- If mig 307 (ledger_event_id FK) has been applied, roll that back first.
-- ============================================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION roadmap.fn_canonical_transition_insert(JSONB)
    FROM claude, agent_write;

DROP FUNCTION IF EXISTS roadmap.fn_canonical_transition_insert(JSONB);

DROP VIEW IF EXISTS roadmap_proposal.v_proposal_transition_ledger;

DROP TABLE IF EXISTS roadmap_proposal.proposal_transition_ledger;

COMMIT;
