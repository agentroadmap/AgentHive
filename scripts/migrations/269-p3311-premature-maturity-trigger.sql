-- 269 — P3311: premature-maturity state-machine invariant (DB-level)
--
-- PROBLEM: "a DEVELOP proposal cannot be 'mature' (= D3-gate-ready) while it has
-- acceptance criteria but ZERO passing/waived" was enforced only in app code
-- (postWorkOffer demote-guard + MCP set_maturity handler). But there are ~7
-- maturity-write paths (MCP handler, pg.setMaturity core fn, cubic gate-evaluator
-- raw UPDATE, state-monitor reeval, legacy-dispatch, reeval-handlers, agent
-- handlers) — the app guards only cover one or two, so the enhancer revise-loop
-- and the codex gate-evaluator can still re-mature unbuilt proposals, producing
-- the recurring D3 skeptic-beta dispatch loop (mature<->new oscillation).
--
-- FIX: enforce the invariant ONCE where every writer must pass — a BEFORE UPDATE
-- OF maturity trigger. Self-healing CLAMP (NEW.maturity := 'new'), mirroring the
-- existing fn_sync_proposal_maturity "reset maturity to new" behaviour, so no
-- caller errors (the codex gate-evaluator's UPDATE simply finds maturity stayed
-- 'new'). The app-layer guards remain as friendly edge messages on top of this
-- DB floor.
--
-- ORDERING: named trg_block_* so it sorts BEFORE trg_gate_ready (which would
-- otherwise emit a spurious orchestrator_wake NOTIFY for a maturity it's about to
-- be clamped away). Firing first, the clamp makes trg_gate_ready see 'new'.
--
-- EVIDENCE: counts status IN ('pass','waived') — a waived AC is a deliberate
-- review decision, not unbuilt work, so it must not be blocked. Zero-AC proposals
-- are left alone (a separate concern; the gate review flags missing ACs).
--
-- OVERRIDE: GUC app.premature_maturity_bypass='true' (mirrors app.gate_bypass).

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_premature_maturity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_total    int;
    v_evidence int;
BEGIN
    -- Only act when something is trying to set maturity='mature' on a DEVELOP
    -- proposal. Everything else passes straight through.
    IF NEW.maturity IS DISTINCT FROM 'mature'
       OR UPPER(COALESCE(NEW.status, '')) <> 'DEVELOP' THEN
        RETURN NEW;
    END IF;

    -- Operator / emergency override.
    IF current_setting('app.premature_maturity_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    SELECT count(*)::int,
           count(*) FILTER (WHERE status IN ('pass', 'waived'))::int
      INTO v_total, v_evidence
      FROM roadmap_proposal.proposal_acceptance_criteria
     WHERE proposal_id = NEW.id;

    -- Has ACs but none passing/waived -> no verified implementation to gate.
    -- Clamp back to 'new' so a developer is dispatched, not the D3 gate.
    IF v_total > 0 AND v_evidence = 0 THEN
        NEW.maturity := 'new';
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_block_premature_maturity ON roadmap_proposal.proposal;
CREATE TRIGGER trg_block_premature_maturity
    BEFORE UPDATE OF maturity ON roadmap_proposal.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_guard_premature_maturity();
