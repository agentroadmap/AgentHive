-- ============================================================================
-- Rollback: Migration 315 — P4668 AC-8/AC-15/AC-18/AC-30/AC-31 audit views
-- ============================================================================
-- Drops all views created in migration 315. Safe to run at any time;
-- these are views only, no schema or data changes.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS roadmap_proposal.v_p4668_missing_actor_host;
DROP VIEW IF EXISTS roadmap_proposal.v_p4668_maturity_demotion_audit;
DROP VIEW IF EXISTS roadmap_proposal.v_backfill_provider_audit;
DROP VIEW IF EXISTS roadmap_proposal.v_provider_mismatch_events;
DROP VIEW IF EXISTS roadmap_proposal.v_p4668_quarantine;
DROP VIEW IF EXISTS roadmap_proposal.v_p4668_state_reconstruction;

COMMIT;
