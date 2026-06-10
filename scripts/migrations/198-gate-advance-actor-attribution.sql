-- 198-gate-advance-actor-attribution.sql
-- Attribute gate auto-advances to the real decider instead of 'system'.
--
-- Problem: fn_apply_gate_advance (059-p611) flips proposal.status when an
-- 'advance' row lands in gate_decision_log, but never sets the
-- app.agent_identity GUC that fn_log_proposal_state_change and
-- fn_notify_maturity_change use for attribution. Every gate-driven advance --
-- the dominant transition path (77/82 state transitions, 301/330 maturity
-- transitions in the 24h to 2026-06-10) -- therefore lands in both ledgers,
-- the audit jsonb, the outbox event, and the pg_notify feed as 'system',
-- even though the trigger knows the decider (NEW.decided_by). The dashboard
-- feed shows "P454 state DEVELOP -> MERGE by system" where the actual actor
-- was claude-gate-xiaomi-one via gate_decision_log id=1486.
--
-- Fix:
--   1. fn_apply_gate_advance adopts NEW.decided_by as the transaction-local
--      app.agent_identity around its status UPDATE, then restores the prior
--      value. Adoption is gated on the identity existing in
--      roadmap_workforce.agent_registry, because
--      proposal_state_transitions.transitioned_by carries an FK to it -- an
--      unregistered decided_by must degrade to 'system', never abort the
--      gate advance.
--   2. fn_log_proposal_state_change / fn_notify_maturity_change treat an
--      empty-string identity as unset (NULLIF) so the restore path -- and the
--      pre-existing ''-identity sessions (2 rows in
--      proposal_maturity_transitions) -- resolve to 'system' instead of ''.
--
-- The maturity mature->new reset on status change (fn_sync_proposal_maturity)
-- is intended behavior and unchanged; it is now attributed correctly.
--
-- Idempotent (CREATE OR REPLACE). Related: 059-p611-gate-decision-auto-advance.

-- 1. Propagate decided_by through the gate auto-advance.
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
        'system/auto-advance',
        'gate-decision:',
        v_body
    );

    RETURN NULL;
END;
$function$;

-- 2. Treat empty-string identity as unset in the state-change logger.
CREATE OR REPLACE FUNCTION roadmap.fn_log_proposal_state_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_agent text;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        v_agent := COALESCE(NULLIF(current_setting('app.agent_identity', true), ''), 'system');

        -- 1. Append to audit jsonb
        NEW.audit := NEW.audit || jsonb_build_object(
            'TS',       to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'Agent',    v_agent,
            'Activity', 'StatusChange',
            'From',     OLD.status,
            'To',       NEW.status
        );

        -- 2. State transitions ledger
        INSERT INTO roadmap_proposal.proposal_state_transitions
            (proposal_id, from_state, to_state, transition_reason, transitioned_by)
        VALUES (NEW.id, OLD.status, NEW.status, 'system', v_agent);

        -- 3. Outbox event
        INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.id,
            'status_changed',
            jsonb_build_object(
                'from',  OLD.status,
                'to',    NEW.status,
                'agent', v_agent,
                'ts',    to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
        );

        -- 4. Real-time notification for Discord feed
        PERFORM pg_notify('proposal_state_changed', jsonb_build_object(
            'proposal_id',      NEW.id,
            'display_id',       NEW.display_id,
            'from_state',       OLD.status,
            'to_state',         NEW.status,
            'transitioned_by',  v_agent,
            'reason',           'system',
            'ts',               to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);
    END IF;
    RETURN NEW;
END;
$function$;

-- 3. Same hardening for the maturity-change logger.
CREATE OR REPLACE FUNCTION roadmap.fn_notify_maturity_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_agent text;
BEGIN
    IF NEW.maturity IS DISTINCT FROM OLD.maturity THEN
        v_agent := COALESCE(NULLIF(current_setting('app.agent_identity', true), ''), 'system');

        -- Maturity transition ledger
        INSERT INTO roadmap_proposal.proposal_maturity_transitions
            (proposal_id, from_maturity, to_maturity, transition_reason, transitioned_by)
        VALUES (NEW.id, OLD.maturity, NEW.maturity, 'system', v_agent);

        -- Real-time notification for Discord feed
        PERFORM pg_notify('proposal_maturity_changed', jsonb_build_object(
            'proposal_id',      NEW.id,
            'display_id',       NEW.display_id,
            'from_maturity',    OLD.maturity,
            'to_maturity',      NEW.maturity,
            'transitioned_by',  v_agent,
            'ts',               to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);
    END IF;
    RETURN NEW;
END;
$function$;
