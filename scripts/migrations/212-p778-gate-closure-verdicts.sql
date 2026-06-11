-- P778: Extend gate_decision_log.decision CHECK constraint to include closure verdicts
--
-- Closure verdicts (wontfix, discard, replace, nonissue) set proposal.maturity='obsolete'
-- and proposal.obsoleted_reason WITHOUT changing proposal.status (unlike approve/advance).
--
-- This migration extends the decision enum to accept the full closure verdict set.

ALTER TABLE roadmap_proposal.gate_decision_log
DROP CONSTRAINT gate_decision_log_decision_check;

ALTER TABLE roadmap_proposal.gate_decision_log
ADD CONSTRAINT gate_decision_log_decision_check
CHECK (decision = ANY (ARRAY[
    'advance'::text,
    'hold'::text,
    'reject'::text,
    'waive'::text,
    'escalate'::text,
    'wontfix'::text,
    'discard'::text,
    'replace'::text,
    'nonissue'::text
]));

COMMENT ON CONSTRAINT gate_decision_log_decision_check ON roadmap_proposal.gate_decision_log IS
'P778: Closure verdicts (wontfix/discard/replace/nonissue) set maturity=obsolete + obsoleted_reason without status change.';
