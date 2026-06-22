-- ============================================================================
-- Rollback for 305-p1391-lease-lifecycle-views.sql
-- ----------------------------------------------------------------------------
-- Drops the two read-only observability views introduced by migration 305.
-- Safe and idempotent (IF EXISTS). No data is touched — these are views only.
--
-- NOTE: 301-p1391-review-round-and-stale-views.sql defines views with the same
-- names. If 301 has separately been applied you may NOT want to drop them here;
-- in normal operation 305 is the canonical applier and 301 was never applied.
-- ============================================================================

DROP VIEW IF EXISTS roadmap_proposal.v_proposal_stale;
DROP VIEW IF EXISTS roadmap_proposal.v_proposal_review_rounds;
