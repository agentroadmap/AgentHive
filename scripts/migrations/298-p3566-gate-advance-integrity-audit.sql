-- Migration 298: P3566 AC-8 — gate-advance integrity audit surface (non-terminal gates)
--
-- Read-only, non-destructive audit of HISTORICAL non-terminal gate advances
-- (DRAFT→REVIEW, REVIEW→DEVELOP) that occurred under the pre-P3566 holes:
--   (a) self-approve  — the advancer was the sole/only approver (no independent
--       approve existed at advance time);
--   (b) later-blocking — a blocking review (is_blocking / request_changes /
--       reject / send_back) was filed AFTER the advance and silently ignored
--       (the TOCTOU tail; reproduces the P3535 02:59→03:06 incident);
--   (c) review-only bypass — the advance has no backing gate_decision_log
--       'advance' row (the legacy 040-p290 bare-approve path).
--
-- AUDIT ONLY: this migration adds views; it does NOT reopen, alter, or revert
-- any proposal. Built on roadmap_proposal.proposal_state_transitions (the status
-- history) rather than gate_decision_log, because the offending advances (incl.
-- P3535) bypassed the log entirely — keying off the log would miss exactly the
-- rows this audit must surface.
--
-- Idempotent: CREATE OR REPLACE VIEW + guarded migration_history insert.

CREATE OR REPLACE VIEW roadmap_proposal.v_gate_advance_integrity_audit AS
SELECT
    pst.proposal_id,
    pst.from_state,
    pst.to_state,
    pst.transitioned_by                       AS advancing_actor,
    pst.transitioned_at                        AS advanced_at,
    -- (a) self-approve: at advance time NO approve review existed from an actor
    -- distinct from the advancer (advancer was the sole approver, or none).
    NOT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id       = pst.proposal_id
          AND pr.verdict           = 'approve'
          AND pr.reviewer_identity IS DISTINCT FROM pst.transitioned_by
          AND pr.reviewed_at      <= pst.transitioned_at
    )                                          AS self_approved,
    -- (b) later-blocking: a blocking review filed AFTER the advance was ignored.
    EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = pst.proposal_id
          AND (pr.is_blocking = true
               OR pr.verdict IN ('request_changes', 'reject', 'send_back'))
          AND pr.reviewed_at > pst.transitioned_at
    )                                          AS later_blocking_review,
    -- (c) review-only bypass: no backing gate_decision_log 'advance' row near
    -- the transition (the post-P3566 requirement; absence ⇒ legacy bare-approve).
    EXISTS (
        SELECT 1
        FROM roadmap_proposal.gate_decision_log gdl
        WHERE gdl.proposal_id   = pst.proposal_id
          AND UPPER(gdl.from_state) = UPPER(pst.from_state)
          AND UPPER(gdl.to_state)   = UPPER(pst.to_state)
          AND gdl.decision      = 'advance'
          AND gdl.created_at BETWEEN pst.transitioned_at - INTERVAL '10 minutes'
                                 AND pst.transitioned_at + INTERVAL '1 minute'
    )                                          AS has_gate_decision_log
FROM roadmap_proposal.proposal_state_transitions pst
WHERE UPPER(pst.from_state) || '→' || UPPER(pst.to_state)
      IN ('DRAFT→REVIEW', 'REVIEW→DEVELOP');

COMMENT ON VIEW roadmap_proposal.v_gate_advance_integrity_audit IS
  'P3566 AC-8: per non-terminal gate advance, flags self_approved / later_blocking_review / missing gate_decision_log. Audit only — never alters proposals.';

-- Convenience view: only the offending advances.
CREATE OR REPLACE VIEW roadmap_proposal.v_gate_advance_integrity_violations AS
SELECT *
FROM roadmap_proposal.v_gate_advance_integrity_audit
WHERE self_approved
   OR later_blocking_review
   OR NOT has_gate_decision_log;

COMMENT ON VIEW roadmap_proposal.v_gate_advance_integrity_violations IS
  'P3566 AC-8: subset of v_gate_advance_integrity_audit where a non-terminal advance was self-approved, ignored a later blocking review, or had no gate_decision_log row (e.g. the P3535 incident).';

-- Ledgered by the migration runner (roadmap.migration_history) at apply time.
