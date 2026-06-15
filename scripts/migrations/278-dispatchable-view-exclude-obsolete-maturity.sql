-- 276 — v_dispatchable_proposal must also exclude OBSOLETE-maturity proposals
--
-- PROBLEM: migration 275 excluded terminal STATUS (COMPLETE) but assumed
-- "OBSOLETE is a maturity, already filtered downstream". It is NOT filtered at
-- the view: observed 90 obsolete-maturity proposals appearing in
-- v_dispatchable_proposal. The orchestrator scans every one each poll cycle.
-- A downstream maturity guard skips them (so no spawns/cost), but they bloat
-- the dispatch scan and obscure the genuinely-dispatchable rows (P1438, P3000).
--
-- FIX: filter obsolete maturity at the view (the source), alongside the
-- COMPLETE status filter from 275. OBSOLETE is the only terminal MATURITY
-- (new/active/mature are all live). gate_scanner_paused=false (P1411) and
-- status <> 'COMPLETE' (275) filters preserved. All consumers are dispatch
-- paths (verified in 275) — none want an obsolete proposal.

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
    AND status <> 'COMPLETE'
    AND maturity <> 'obsolete';
