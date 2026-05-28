-- Migration 140: P1386 — architect early-exit predicate
--
-- Defines roadmap_proposal.v_architect_early_exit(p_proposal_id BIGINT)
-- returning BOOLEAN: true iff the architect role has no design work to do
-- for the given proposal.
--
-- Used by offer-dispatch.ts (Layer 1) before launching the architect agent.
-- When true, the orchestrator writes a synthetic agent_runs completion row
-- and completes the offer mechanically, avoiding a 5-min idle spawn + SIGTERM.
--
-- Predicate (all conditions must hold):
--   1. ≥1 proposal_acceptance_criteria row AND every row has status ∈ ('pass','waived')
--   2. proposal.design IS NOT NULL AND length(design) >= 200
--   3. No proposal_discussions row with context_prefix='design_gap:' newer
--      than proposal.updated_at (any open gap reopens the design)
--
-- Audit log on P1104: 38 architect dispatches in 24h despite 6 ACs verified
-- pass since 2026-05-16. This predicate would have early-exited all 38.

BEGIN;

CREATE OR REPLACE FUNCTION roadmap_proposal.v_architect_early_exit(
	p_proposal_id BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
	v_ac_total INT;
	v_ac_unsatisfied INT;
	v_design_len INT;
	v_proposal_updated_at TIMESTAMPTZ;
	v_open_gaps INT;
BEGIN
	-- (1) Require ≥1 AC; all must be pass/waived.
	-- Vacuous true on zero ACs would early-exit unbroken-down proposals,
	-- but architect's job may include creating the AC structure itself.
	SELECT count(*),
	       count(*) FILTER (WHERE status NOT IN ('pass', 'waived'))
	INTO v_ac_total, v_ac_unsatisfied
	FROM roadmap_proposal.proposal_acceptance_criteria
	WHERE proposal_id = p_proposal_id;

	IF v_ac_total = 0 OR v_ac_unsatisfied > 0 THEN
		RETURN FALSE;
	END IF;

	-- (2) Design must be substantive.
	SELECT COALESCE(length(design), 0), updated_at
	INTO v_design_len, v_proposal_updated_at
	FROM roadmap_proposal.proposal
	WHERE id = p_proposal_id;

	IF v_design_len < 200 THEN
		RETURN FALSE;
	END IF;

	-- (3) No open design_gap newer than last proposal edit.
	-- Using proposal.updated_at as the design-edit watermark — any edit
	-- that should retire a prior design_gap will have bumped updated_at.
	SELECT count(*)
	INTO v_open_gaps
	FROM roadmap_proposal.proposal_discussions
	WHERE proposal_id = p_proposal_id
	  AND context_prefix = 'design_gap:'
	  AND created_at > v_proposal_updated_at;

	IF v_open_gaps > 0 THEN
		RETURN FALSE;
	END IF;

	RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.v_architect_early_exit(BIGINT) IS
'P1386 AC-1: returns true iff architect role has no design work for proposal — used by offer-dispatch.ts Layer 1 to skip idle spawns.';

COMMIT;
