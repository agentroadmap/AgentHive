-- 294-p3840-remove-auto-gating-roles.sql
--
-- Operator directive (2026-06-17): "remove auto gating pipeline, add d1 to d4
-- gating to orchestrator job offer list."
--
-- CONTEXT: roadmap.agent_role_profile dispatches, for maturity='mature'
-- proposals, a set of GATE-DECISION roles (reviewer-d1..d4, gate_decision_agent,
-- merge_decision_agent, gate-agent, gate-reviewer). scanQueues pulls mature
-- proposals and the A2A host spawns these as `claude --print` agents that
-- AUTO-ADVANCE the gate (D1-D4) once a quorum of reviews exists. This is the
-- "automatic gating" the operator does not want: gating should instead be a
-- POSTED JOB OFFER on the orchestrator's job list, claimed and decided
-- deliberately (P3840). The reviewer/skeptic/architect/qa/developer/drafter/
-- enrichment roles are NOT gate deciders and are KEPT — proposals still get
-- drafted/reviewed/developed; they simply no longer auto-advance.
--
-- This migration removes ONLY the gate-decision roles. Applied live
-- 2026-06-17 ahead of file (control-plane config; getRolesForQueue reads the
-- table live, no restart needed). Rollback re-seeds functional equivalents.

BEGIN;

DELETE FROM roadmap.agent_role_profile
WHERE role IN (
    'reviewer-d1', 'reviewer-d2', 'reviewer-d3', 'reviewer-d4',
    'gate_decision_agent', 'merge_decision_agent',
    'gate-agent', 'gate-reviewer'
);

COMMIT;
