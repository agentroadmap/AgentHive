-- ============================================================================
-- Migration 301 — P1391 AC6 + AC7: review-round counter + stale-proposal views
-- ----------------------------------------------------------------------------
-- Two READ-ONLY views. Purely additive (CREATE OR REPLACE VIEW); they install
-- no triggers, alter no tables, and change no existing behavior. Safe to apply
-- independently of the AGENTHIVE_GATE_AUTHORITY_ENABLED rollout — they only
-- READ gate_decision_log / proposal / proposal_lease.
--
-- AC6 — v_proposal_review_rounds: per-proposal count of send-back ("hold") and
--       reject verdicts in gate_decision_log, plus a 1-based review_round
--       (review_round = 1 + holds + rejects). Counts BOTH the legacy `hold`
--       verdict AND the P1391 canonical `request_for_change` so the counter is
--       correct before AND after the (operator-gated) vocab migration.
--
-- AC7 — v_proposal_stale: proposals that are maturity='active', have NO live
--       lease (lease_is_live() over the latest lease row is false / no row),
--       and whose modified_at is older than the staleness horizon (default 7
--       days). A proposal touched within the horizon is excluded (recent
--       activity).
--
-- Idempotent; NO inner BEGIN/COMMIT. Lint with:
--   psql -1 -f scripts/migrations/301-p1391-review-round-and-stale-views.sql
-- (run on a transaction you ROLLBACK).
-- ============================================================================

-- ── AC6: review-round counter ───────────────────────────────────────────────
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_review_rounds AS
SELECT
  p.id                                                       AS proposal_id,
  p.display_id,
  COUNT(*) FILTER (
    WHERE gdl.decision IN ('hold', 'request_for_change')
  )                                                          AS hold_count,
  COUNT(*) FILTER (
    WHERE gdl.decision = 'reject'
  )                                                          AS reject_count,
  -- 1-based round: a proposal with zero send-backs is in review_round 1; each
  -- hold / reject bumps the round it must re-enter.
  1
    + COUNT(*) FILTER (WHERE gdl.decision IN ('hold', 'request_for_change'))
    + COUNT(*) FILTER (WHERE gdl.decision = 'reject')        AS review_round
FROM roadmap_proposal.proposal p
LEFT JOIN roadmap_proposal.gate_decision_log gdl
  ON gdl.proposal_id = p.id
GROUP BY p.id, p.display_id;

COMMENT ON VIEW roadmap_proposal.v_proposal_review_rounds IS
  'P1391 AC6: per-proposal send-back/reject counts and 1-based review_round '
  '(1 + holds + rejects). hold_count includes legacy ''hold'' and canonical '
  '''request_for_change''. Read-only.';

-- ── AC7: stale active-but-idle proposals ────────────────────────────────────
-- A proposal is stale iff: maturity='active' AND it has NO live lease AND it
-- has not been modified within the horizon. The horizon is inlined as 7 days;
-- callers that want a different window can filter on modified_at directly.
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_stale AS
SELECT
  p.id            AS proposal_id,
  p.display_id,
  p.status,
  p.maturity,
  p.modified_at,
  (now() - p.modified_at) AS idle_for
FROM roadmap_proposal.proposal p
WHERE p.maturity = 'active'
  AND p.modified_at < now() - INTERVAL '7 days'
  -- No LIVE lease on this proposal (released or expired ⇒ eligible to be stale).
  AND NOT EXISTS (
    SELECT 1
      FROM roadmap_proposal.proposal_lease pl
     WHERE pl.proposal_id = p.id
       AND roadmap_proposal.lease_is_live(pl.released_at, pl.expires_at)
  );

COMMENT ON VIEW roadmap_proposal.v_proposal_stale IS
  'P1391 AC7: maturity=active proposals with NO live lease and modified_at '
  'older than 7 days (truly idle). Uses lease_is_live() for liveness. Read-only.';
