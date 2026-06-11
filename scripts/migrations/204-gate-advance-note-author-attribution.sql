-- 204-gate-advance-note-author-attribution.sql
-- Attribute the gate auto-advance discussion notes to the real decider.
--
-- Follow-up to 198-gate-advance-actor-attribution.sql. Migration 198 made
-- fn_apply_gate_advance adopt NEW.decided_by as app.agent_identity around the
-- status UPDATE, so the state/maturity ledgers, audit jsonb, outbox event, and
-- pg_notify feed are now attributed to the real decider. But the function's
-- own bookkeeping notes -- the drift-guard WARNING and the "Auto-advanced ..."
-- success note -- are still INSERTed into proposal_discussions with
-- author_identity hardcoded to 'system/auto-advance'. The dashboard feed
-- therefore renders "system/auto-advance [gate-decision]" for an advance a
-- named agent actually decided (e.g. P1438 -> DEVELOP via gate_decision_log
-- id=1679, decided_by claude-bot-gary, still shows as system).
--
-- Fix: compute v_author from NEW.decided_by, gated on the identity existing in
-- roadmap_workforce.agent_registry (proposal_discussions.author_identity
-- carries an FK to it), falling back to 'system/auto-advance' when decided_by
-- is null or unregistered -- so an unregistered decider degrades gracefully and
-- never aborts the advance. Use v_author as author_identity in BOTH discussion
-- INSERTs. No change to the status/maturity flip, app.gate_bypass, or the
-- existing app.agent_identity adoption logic.
--
-- Idempotent (CREATE OR REPLACE). Related: 059-p611-gate-decision-auto-advance,
-- 198-gate-advance-actor-attribution. Proposal: P2969.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_apply_gate_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'roadmap_proposal', 'pg_temp'
AS $function$
DECLARE
    v_proposal       RECORD;
    v_body           TEXT;
    v_prev_identity  TEXT;
    v_author         TEXT;
BEGIN
    -- Only act on advance decisions; ignore hold/reject/waive/escalate.
    IF NEW.decision != 'advance' THEN
        RETURN NULL;
    END IF;

    -- Resolve the note author: the real decider when it satisfies the
    -- proposal_discussions.author_identity FK to agent_registry, else the
    -- 'system/auto-advance' fallback. Never let an unregistered decided_by
    -- abort the advance via a FK violation on the bookkeeping note.
    IF NEW.decided_by IS NOT NULL AND EXISTS (
        SELECT 1 FROM roadmap_workforce.agent_registry
         WHERE agent_identity = NEW.decided_by
    ) THEN
        v_author := NEW.decided_by;
    ELSE
        v_author := 'system/auto-advance';
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
            v_author,
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

    -- Attribute the cascaded ledger writes (state transitions, maturity
    -- transitions, audit jsonb, outbox event, pg_notify feed) to the real
    -- decider instead of 'system'. Only adopt identities that satisfy the
    -- agent_registry FK on proposal_state_transitions.transitioned_by; an
    -- unregistered decided_by falls back to the session identity / 'system'
    -- rather than aborting the advance.
    v_prev_identity := current_setting('app.agent_identity', true);
    IF NEW.decided_by IS NOT NULL AND EXISTS (
        SELECT 1 FROM roadmap_workforce.agent_registry
         WHERE agent_identity = NEW.decided_by
    ) THEN
        PERFORM set_config('app.agent_identity', NEW.decided_by, true);
    END IF;

    UPDATE roadmap_proposal.proposal
       SET status   = NEW.to_state,
           maturity = 'new'
     WHERE id = NEW.proposal_id;

    -- Restore the caller's identity for the rest of its transaction.
    -- '' reads as unset downstream (NULLIF in the logging functions).
    PERFORM set_config('app.agent_identity', COALESCE(v_prev_identity, ''), true);

    v_body := format(
        'Auto-advanced %s->%s via gate_decision_log id=%s (decided_by: %s). Trigger: fn_apply_gate_advance.',
        NEW.from_state, NEW.to_state, NEW.id, NEW.decided_by
    );

    INSERT INTO roadmap_proposal.proposal_discussions
        (proposal_id, author_identity, context_prefix, body)
    VALUES (
        NEW.proposal_id,
        v_author,
        'gate-decision:',
        v_body
    );

    RETURN NULL;
END;
$function$;
