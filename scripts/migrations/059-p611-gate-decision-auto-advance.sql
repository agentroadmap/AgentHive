-- Migration 059 — P611: Gate decision auto-advance
-- Implements a dual-path defense-in-depth mechanism:
--   1. AFTER INSERT trigger on gate_decision_log that atomically flips proposal.status
--   2. Agent identities for system/auto-advance and system/reconciler audit trail entries
--
-- Trigger fires within the same transaction as the gate_decision_log INSERT.
-- If the status UPDATE fails, both INSERT and UPDATE roll back together.
-- SET LOCAL app.gate_bypass='true' is required because fn_guard_gate_advance (migration 040)
-- checks this setting; the new gate_decision_log row isn't visible to the guard's SELECT
-- yet (same transaction), so the bypass flag is the correct mechanism.

BEGIN;

-- ─── Register system identities for audit trail entries ─────────────────────

INSERT INTO roadmap_workforce.agent_registry
    (agent_identity, agent_type, status, trust_tier, project_id)
VALUES
    ('system/auto-advance', 'tool', 'active', 'restricted', 1),
    ('system/reconciler',   'tool', 'active', 'restricted', 1)
ON CONFLICT (agent_identity) DO NOTHING;

-- ─── Trigger function: apply a gate advance atomically ───────────────────────

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_apply_gate_advance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, pg_temp
AS $$
DECLARE
    v_proposal  RECORD;
    v_body      TEXT;
BEGIN
    -- Only act on advance decisions; ignore hold/reject/waive/escalate.
    IF NEW.decision != 'advance' THEN
        RETURN NULL;
    END IF;

    -- Lock the target row; surface contention as an error rather than a silent hang.
    SET LOCAL lock_timeout = '5s';

    SELECT id, status, maturity
      INTO v_proposal
      FROM roadmap_proposal.proposal
     WHERE id = NEW.proposal_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Idempotent: already at the target state — nothing to do.
    IF UPPER(v_proposal.status) = UPPER(NEW.to_state) THEN
        RETURN NULL;
    END IF;

    -- Drift guard: current state doesn't match expected from_state.
    -- Log a warning discussion entry and bail; do NOT flip the status.
    IF UPPER(v_proposal.status) != UPPER(NEW.from_state) THEN
        INSERT INTO roadmap_proposal.proposal_discussions
            (proposal_id, author_identity, context_prefix, body)
        VALUES (
            NEW.proposal_id,
            'system/auto-advance',
            'gate-decision:',
            format(
                'WARNING: gate_decision_log id=%s expects from=%s but proposal.status=%s (to=%s). No action.',
                NEW.id, NEW.from_state, v_proposal.status, NEW.to_state
            )
        );
        RETURN NULL;
    END IF;

    -- Bypass fn_guard_gate_advance for this transaction; SET LOCAL is transaction-scoped.
    SET LOCAL app.gate_bypass = 'true';

    UPDATE roadmap_proposal.proposal
       SET status   = NEW.to_state,
           maturity = 'new'
     WHERE id = NEW.proposal_id;

    v_body := format(
        'Auto-advanced %s->%s via gate_decision_log id=%s (decided_by: %s). Trigger: fn_apply_gate_advance.',
        NEW.from_state, NEW.to_state, NEW.id, NEW.decided_by
    );

    INSERT INTO roadmap_proposal.proposal_discussions
        (proposal_id, author_identity, context_prefix, body)
    VALUES (
        NEW.proposal_id,
        'system/auto-advance',
        'gate-decision:',
        v_body
    );

    RETURN NULL;
END;
$$;

-- Postgres 14 has no CREATE OR REPLACE TRIGGER, so drop then recreate.
DROP TRIGGER IF EXISTS trg_apply_gate_advance
    ON roadmap_proposal.gate_decision_log;

CREATE TRIGGER trg_apply_gate_advance
    AFTER INSERT ON roadmap_proposal.gate_decision_log
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_apply_gate_advance();

COMMIT;
