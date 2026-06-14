-- 275 — v_dispatchable_proposal must exclude terminal (COMPLETE) proposals
--
-- PROBLEM: v_dispatchable_proposal filtered ONLY gate_scanner_paused=false, so
-- COMPLETE proposals stayed "dispatchable". The orchestrator dispatch paths
-- (orchestrator.ts:560/951, legacy-dispatch.ts:1907/2229) read this view, kept
-- selecting COMPLETE proposals (observed: P463/1375/3311/3312/3313 each ~16x/15min
-- = ~320 attempts/hr), and postWorkOffer's TerminalProposalError guard refused
-- every one. Harmless (no spawns/cost) but wasteful scan cycles + log spam that
-- masks real dispatch errors.
--
-- FIX: filter terminal status at the view (the source). The TerminalProposalError
-- guard in postWorkOffer remains as a defensive backstop. COMPLETE is the only
-- terminal proposal STATUS (OBSOLETE is a maturity, already filtered downstream).
-- All consumers are dispatch paths (verified) — none want a COMPLETE proposal.
-- gate_scanner_paused=false filter is preserved (P1411).

CREATE OR REPLACE VIEW roadmap_proposal.v_dispatchable_proposal AS
 SELECT id,
        display_id,
        parent_id,
        type,
        status,
        title,
        summary,
        motivation,
        design,
        drawbacks,
        alternatives,
        dependency_note,
        priority,
        maturity,
        workflow_name,
        status_term_category,
        maturity_term_category,
        body_vector,
        tags,
        audit,
        created_at,
        modified_at,
        required_capabilities,
        project_id,
        gate_scanner_paused,
        gate_paused_by,
        gate_paused_at,
        gate_paused_reason,
        obsoleted_reason,
        findings,
        phase_id,
        reeval_exempt_until,
        reeval_count
   FROM proposal
  WHERE gate_scanner_paused = false
    AND status <> 'COMPLETE';
