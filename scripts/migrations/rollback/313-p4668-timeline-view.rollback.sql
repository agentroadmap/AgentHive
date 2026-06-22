-- ============================================================================
-- Rollback for Migration 313 — P4668 Unified timeline view
-- ----------------------------------------------------------------------------
-- Drops the v_proposal_unified_timeline view.
-- No data is lost; the underlying tables are untouched.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS roadmap_proposal.v_proposal_unified_timeline;

COMMIT;
