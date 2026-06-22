-- ============================================================================
-- Rollback for Migration 311 — P4668 Direct-write enforcement
-- ----------------------------------------------------------------------------
-- Restores INSERT permission on proposal_transition_ledger for application
-- roles so that the dual-write shim window can resume.
--
-- When to use: Only if mig 311 was applied prematurely (divergence still
-- non-zero) and TypeScript callers need to resume direct inserts temporarily.
-- After rollback, re-run fn_p4668_backfill_history(false, 500) and re-check
-- v_enforcement_preflight before re-applying 311.
-- ============================================================================

BEGIN;

GRANT INSERT ON roadmap_proposal.proposal_transition_ledger
    TO claude, andy, admin_write, agent_write;

DROP VIEW IF EXISTS roadmap_proposal.v_enforcement_preflight;

COMMENT ON TABLE roadmap_proposal.proposal_transition_ledger IS
    'P4668 AC-1: Append-only canonical event ledger. '
    'Enforcement NOT YET active (mig 311 rolled back). '
    'INSERT permitted for application roles during dual-write window. '
    'UPDATE and DELETE are REVOKED from all application roles (mig 306).';

-- Note: the comment on fn_shadow_write_to_ledger() does not need reverting —
-- the historical note is accurate regardless of enforcement state.

COMMIT;
