-- ============================================================================
-- Rollback for migration 301 — P1391 AC6/AC7 views.
-- Both views are additive and read-only; dropping them restores the prior
-- state exactly (nothing else referenced them). Idempotent.
-- ============================================================================
DROP VIEW IF EXISTS roadmap_proposal.v_proposal_stale;
DROP VIEW IF EXISTS roadmap_proposal.v_proposal_review_rounds;
