-- 264-p906-gate-advance-drop-bypass.sql
-- P906 (P902-C): Eliminate the app.gate_bypass mutation shortcut from the
-- gate-advance trigger path, enforcing the single-writer invariant
-- (CONVENTIONS.md §6.0b).
--
-- Context
-- -------
-- fn_apply_gate_advance fires AFTER INSERT on gate_decision_log and flips
-- proposal.status/maturity when an 'advance' row lands. Since 059-p611 it has
-- issued `SET LOCAL app.gate_bypass = 'true'` immediately before the UPDATE so
-- that the BEFORE UPDATE guard (fn_guard_gate_advance, 040-p290) short-circuits
-- and never re-checks for a gate decision. That bypass is a second, implicit
-- mutation shortcut: it tells the guard "trust me, skip your checks" instead of
-- letting the guard satisfy itself from the ledger.
--
-- The reconciler (reconcileStrandedAdvances, P902-A, commit 6725408d) is
-- already notify-only — it emits 'stranded-gate-advance' notifications and
-- never mutates proposal.status — so the gate trigger is the last remaining
-- user of app.gate_bypass on the production status path.
--
-- Why removing the bypass is SAFE
-- -------------------------------
-- The gate_decision_log row is INSERTed in the SAME transaction, BEFORE the
-- AFTER INSERT trigger runs the UPDATE that fires the BEFORE UPDATE guard.
-- Within that transaction the freshly-inserted row is visible to the guard's
-- own lookup (Branch B):
--
--     SELECT EXISTS (
--       SELECT 1 FROM roadmap_proposal.gate_decision_log gdl
--        WHERE gdl.proposal_id = NEW.id
--          AND UPPER(gdl.from_state) = UPPER(OLD.status)
--          AND UPPER(gdl.to_state)   = UPPER(NEW.status)
--          AND gdl.decision = 'advance'
--          AND gdl.created_at >= now() - INTERVAL '10 minutes')
--
-- OLD.status = NEW.from_state and NEW.status = NEW.to_state for a legitimate
-- advance, so this EXISTS matches and the guard returns NEW WITHOUT the bypass.
-- This was verified empirically against the live schema: with the bypass line
-- removed, advancing a REVIEW proposal REVIEW→DEVELOP via a gate_decision_log
-- INSERT succeeds; a bare UPDATE with no decision log is still rejected
-- (guard remains active). See scripts/migrations/__tests__/
-- p906-gate-bypass-removal.test.ts.
--
-- This migration
-- --------------
--   1. Redefines fn_apply_gate_advance identical to 204-gate-advance-note-
--      author-attribution.sql EXCEPT the `SET LOCAL app.gate_bypass = 'true'`
--      statement is removed. Status/maturity flip, decider attribution, and the
--      two bookkeeping discussion notes are unchanged.
--   2. Updates the COMMENT on fn_guard_gate_advance: the bypass check
--      (current_setting('app.gate_bypass')) is preserved as a defensive no-op
--      for ad-hoc operator/admin transactions, but the production gate trigger
--      no longer sets it (per P906 / single-writer invariant).
--
-- The guard's bypass *check* is intentionally left in place (still honored by
-- manual `SET LOCAL app.gate_bypass='true'` in operator transactions); only the
-- trigger's *setting* of the flag is removed.
--
-- Idempotent (CREATE OR REPLACE + COMMENT ON). Related: 059-p611, 040-p290,
-- 198-gate-advance-actor-attribution, 204-gate-advance-note-author-attribution.
-- Proposal: P906.

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

    -- P906 (P902-C): the `SET LOCAL app.gate_bypass = 'true'` that previously
    -- sat here has been removed. The gate_decision_log row is inserted in this
    -- same transaction before this trigger fires, so fn_guard_gate_advance's
    -- own ledger lookup (Branch B) finds it and passes WITHOUT the bypass.
    -- This keeps a single, guard-validated proposal-status mutation path.

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

-- AC-2: the guard keeps its app.gate_bypass *check* as a defensive no-op for
-- ad-hoc operator/admin transactions, but document that the production gate
-- trigger (fn_apply_gate_advance) no longer SETs it after P906.
COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
  'P290 + P181: Enforces gated status transitions. Standard RFC: D1(DRAFT→REVIEW), D2(REVIEW→DEVELOP), D3(DEVELOP→MERGE), D4(MERGE→COMPLETE). governance-amendment adds DELIBERATION stage: D1(DRAFT→DELIBERATION), D2(DELIBERATION→REVIEW, 48h timing gate), D3(REVIEW→DEVELOP), D4(DEVELOP→MERGE), D5(MERGE→COMPLETE, human agent_type required). The app.gate_bypass check is preserved as a defensive no-op for ad-hoc operator/admin transactions (SET LOCAL app.gate_bypass=''true''); per P906 (P902-C) the production gate trigger fn_apply_gate_advance NO LONGER sets it — gate advances satisfy Branch B via same-transaction gate_decision_log visibility, enforcing the single-writer invariant (CONVENTIONS.md §6.0b).';
