-- ============================================================================
-- Migration 305 — P1391 AC-6 + AC-7: review-round counter + stale-proposal views
-- ----------------------------------------------------------------------------
-- Two READ-ONLY views. Purely additive (CREATE OR REPLACE VIEW); they install
-- no triggers, alter no tables, and change no existing behavior. They only READ
-- gate_decision_log / proposal / proposal_lease.
--
-- Numbered 305 to avoid a prefix collision with the existing
-- 301-p1391-review-round-and-stale-views.sql (which was authored but never
-- applied to the live DB). This file is the canonical, ledgered applier and
-- grounds its predicates against the LIVE schema:
--   * gate_decision_log.decision CHECK currently allows only
--       {advance, hold, reject, waive, escalate, wontfix, discard, replace, nonissue}
--     — there is NO `request_for_change` value in the live vocab, so the AC-6
--     counters key off `hold` / `reject` exactly (matching production rows).
--   * AC-7 routes liveness through the existing SQL helper
--       roadmap_proposal.lease_is_live(released_at, expires_at)
--     (installed by 283-p1391-lease-ttl-structural.sql, already live).
--
-- This migration deliberately does NOT touch the gate_decision_log.decision
-- CHECK constraint (P1391 AC-17) nor migrate historical `hold` rows (AC-18):
-- the legacy verdict vocab is still in live use and constraining it now would
-- break production. AC-17/18 remain pending / operator-gated.
--
-- Idempotent; CREATE OR REPLACE VIEW is safe to re-run. Lint with:
--   psql -1 -f scripts/migrations/305-p1391-lease-lifecycle-views.sql
-- (run inside a transaction you ROLLBACK).
-- ============================================================================

-- ── AC-6: review-round counter ──────────────────────────────────────────────
-- Per proposal:
--   hold_count    = # gate_decision_log rows with decision='hold'
--   reject_count  = # gate_decision_log rows with decision='reject'
--   review_round  = 1 + hold_count + reject_count  (1-based; a proposal with no
--                   send-backs is in round 1, each hold/reject bumps the round).
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_review_rounds AS
SELECT
  p.id                                                          AS proposal_id,
  p.display_id,
  COUNT(*) FILTER (WHERE gdl.decision IN ('hold', 'request_for_change')) AS hold_count,
  COUNT(*) FILTER (WHERE gdl.decision = 'reject')                        AS reject_count,
  1
    + COUNT(*) FILTER (WHERE gdl.decision IN ('hold', 'request_for_change'))
    + COUNT(*) FILTER (WHERE gdl.decision = 'reject')                    AS review_round
FROM roadmap_proposal.proposal p
LEFT JOIN roadmap_proposal.gate_decision_log gdl
  ON gdl.proposal_id = p.id
GROUP BY p.id, p.display_id;

COMMENT ON VIEW roadmap_proposal.v_proposal_review_rounds IS
  'P1391 AC-6: per-proposal hold/reject counts from gate_decision_log and a '
  '1-based review_round (1 + holds + rejects). hold_count counts legacy ''hold'' '
  'AND canonical ''request_for_change'' so it is correct before AND after the '
  '(operator-gated) AC-17/18 vocab migration. Read-only; no triggers, no writes.';

-- ── AC-7: stale active-but-idle proposals ───────────────────────────────────
-- A proposal is stale iff: maturity='active' AND modified_at is older than the
-- 7-day horizon AND it has NO live lease. Liveness is delegated to the existing
-- lease_is_live() helper so a released-OR-expired lease makes the proposal
-- eligible to be reported as stale.
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_stale AS
SELECT
  p.id                     AS proposal_id,
  p.display_id,
  p.status,
  p.maturity,
  p.modified_at,
  (now() - p.modified_at)  AS idle_for
FROM roadmap_proposal.proposal p
WHERE p.maturity = 'active'
  AND p.modified_at < now() - INTERVAL '7 days'
  AND NOT EXISTS (
    SELECT 1
      FROM roadmap_proposal.proposal_lease pl
     WHERE pl.proposal_id = p.id
       AND roadmap_proposal.lease_is_live(pl.released_at, pl.expires_at)
  );

COMMENT ON VIEW roadmap_proposal.v_proposal_stale IS
  'P1391 AC-7: maturity=active proposals with NO live lease (per lease_is_live()) '
  'and modified_at older than 7 days. Read-only; no triggers, no writes.';
