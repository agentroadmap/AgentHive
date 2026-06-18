-- 299-p3929-drop-nonterminal-gate-bypass.sql
-- P3929: Remove app.gate_bypass honour for non-terminal gates (DRAFT→REVIEW,
-- REVIEW→DEVELOP) and eliminate the SET LOCAL bypass from fn_apply_gate_advance.
--
-- Background
-- ----------
-- P906/mig264 proved that fn_apply_gate_advance does NOT need to SET LOCAL
-- app.gate_bypass='true' before the status UPDATE because fn_guard_gate_advance's
-- own gate_decision_log lookup finds the just-inserted row within the same
-- transaction (same-txn visibility).  P906 removed the SET LOCAL from
-- fn_apply_gate_advance and left the bypass *check* in fn_guard_gate_advance as a
-- "defensive no-op for ad-hoc operator/admin transactions."
--
-- P3566/mig270 inadvertently un-did both halves of P906:
--   1. fn_guard_gate_advance (lines ~156-158) honours app.gate_bypass='true' with
--      an early RETURN NEW that comes BEFORE the non-terminal gate check, so a
--      transaction that sets the flag bypasses ALL of P3566's AC-1/2/3 invariants
--      (independent approver, unresolved blocker, mandatory gate_decision_log).
--   2. fn_apply_gate_advance (line ~377) re-added `SET LOCAL app.gate_bypass='true'`
--      before the status UPDATE, creating the same implicit shortcut P906 removed.
--
-- This migration restores the P906 invariants on the non-terminal path:
--   A. fn_guard_gate_advance: the bypass check is moved to AFTER the non-terminal
--      section, so it can only fire on terminal gates (D3 DEVELOP→MERGE,
--      D4 MERGE→COMPLETE) where it remains a valid operator escape hatch and is
--      never reached by fn_apply_gate_advance's own re-entrant call anyway
--      (same-txn gate_decision_log lookup returns true first).
--   B. fn_apply_gate_advance: `SET LOCAL app.gate_bypass = 'true'` is removed
--      entirely (re-proving P906: the gate_decision_log row is in the same txn).
--
-- fn_reconcile_late_blocking_review keeps its SET LOCAL (auto-send-back only):
-- the reverted status is a backwards move (DEVELOP→REVIEW, REVIEW→DRAFT) which
-- is NOT in fn_guard_gate_advance's gate key list, so the guard returns NEW
-- immediately and the bypass is belt-and-suspenders there.
--
-- AC-3 proof: no TypeScript/JavaScript production code sets app.gate_bypass.
-- grep -r "app\.gate_bypass" src/ → 0 hits (only migrations and tests).
--
-- HIGH blast radius (fn_guard_gate_advance fires on every proposal status advance).
-- Applied in an operator-supervised window. Rollback: restore fn_guard_gate_advance
-- and fn_apply_gate_advance from mig 270 (captured in the rollback file at
-- scripts/migrations/rollback/299-p3929-rollback.sql).
--
-- Idempotent (CREATE OR REPLACE). Prerequisite: 270 applied.

BEGIN;

-- ─── PREFLIGHT ────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'roadmap_proposal'
           AND p.proname = 'fn_guard_gate_advance'
    ) THEN
        RAISE EXCEPTION 'Prerequisite 270-p3566-gate-advance-authorization-integrity.sql '
            'not applied: roadmap_proposal.fn_guard_gate_advance() missing.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'roadmap_proposal'
           AND p.proname = 'fn_apply_gate_advance'
    ) THEN
        RAISE EXCEPTION 'Prerequisite 270-p3566-gate-advance-authorization-integrity.sql '
            'not applied: roadmap_proposal.fn_apply_gate_advance() missing.';
    END IF;
END;
$$;

-- ─── A. fn_guard_gate_advance: move bypass AFTER non-terminal section ──────────
-- The only structural change is:
--   (a) v_is_nonterminal is computed BEFORE the bypass check, not after.
--   (b) The bypass RETURN NEW is gated by NOT v_is_nonterminal, so DRAFT→REVIEW
--       and REVIEW→DEVELOP ALWAYS run the gate_decision_log enforcement path.
--   (c) All non-terminal and terminal gate logic is otherwise identical to mig 270.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate_key        TEXT;
    v_has_decision    BOOLEAN;
    v_is_nonterminal  BOOLEAN;
BEGIN
    -- Only act on forward gated status changes.
    v_gate_key := UPPER(OLD.status) || E'→' || UPPER(NEW.status);

    IF v_gate_key NOT IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE'
    ) THEN
        RETURN NEW;
    END IF;

    -- Classify gate type first so the bypass can be scoped to terminal-only.
    v_is_nonterminal := v_gate_key IN (E'DRAFT→REVIEW', E'REVIEW→DEVELOP');

    -- P3929: bypass is honored ONLY for terminal gates (D3, D4) as an operator
    -- escape hatch.  Non-terminal gates (D1, D2) ALWAYS enforce gate_decision_log
    -- + AC-1/2/3 checks regardless of the app.gate_bypass flag.
    --
    -- For fn_apply_gate_advance's own re-entrant call on terminal gates: the
    -- gate_decision_log lookup below finds the same-txn row and passes, so the
    -- bypass is never actually reached — it exists only for ad-hoc operator txns.
    IF NOT v_is_nonterminal AND current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    -- ── Non-terminal gates (D1, D2): ONLY gate_decision_log advance row accepted.
    -- (AC-3, P3566) fn_apply_gate_advance is the sole path that inserts this row
    -- and then updates proposal.status; the row is visible within the same txn so
    -- this lookup passes without needing the bypass.
    IF v_is_nonterminal THEN
        SELECT EXISTS (
            SELECT 1
            FROM roadmap_proposal.gate_decision_log gdl
            WHERE gdl.proposal_id = NEW.id
              AND UPPER(gdl.from_state) = UPPER(OLD.status)
              AND UPPER(gdl.to_state)   = UPPER(NEW.status)
              AND gdl.decision = 'advance'
              AND gdl.created_at >= now() - INTERVAL '10 minutes'
        ) INTO v_has_decision;

        IF v_has_decision THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION
            'Non-terminal gate % → % on proposal % requires record_gate_decision. '
            'Direct status updates on gated edges are not permitted (P3566/AC-3). '
            'Submit an independent review (proposal_reviews verdict=approve, reviewer != advancer), '
            'then call record_gate_decision(decision=advance) — the trigger will advance the status.',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- ── Terminal gates (D3, D4): dual-branch unchanged from P3566/mig270 ─────────

    -- Check gate_decision_log for a recent advance decision.
    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.gate_decision_log gdl
        WHERE gdl.proposal_id = NEW.id
          AND UPPER(gdl.from_state) = UPPER(OLD.status)
          AND UPPER(gdl.to_state)   = UPPER(NEW.status)
          AND gdl.decision = 'advance'
          AND gdl.created_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN
        RETURN NEW;
    END IF;

    -- Check proposal_reviews for an approve verdict (terminal gates only — P3563
    -- may tighten this branch further; kept for backward compat until P3563 ships).
    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = NEW.id
          AND pr.verdict = 'approve'
          AND pr.reviewed_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'Gate transition % → % on proposal % requires a gate decision. '
        'Submit a gate review (proposal_reviews verdict=approve) or '
        'gate_decision_log (decision=advance) within the last 10 minutes before advancing.',
        OLD.status, NEW.status, NEW.id
        USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
    'P3566/P290/P3929: Enforces that gated status transitions require authorization. '
    'Non-terminal gates (D1 DRAFT→REVIEW, D2 REVIEW→DEVELOP): only gate_decision_log '
    'advance row accepted; app.gate_bypass is NOT honoured (P3929 regression fix — '
    'P3566/mig270 re-introduced the bypass that P906/mig264 removed). '
    'Terminal gates (D3, D4): dual-branch unchanged pending P3563; app.gate_bypass '
    'honoured as operator escape hatch only. '
    'Independence + blocking checks enforced in fn_apply_gate_advance.';

-- ─── B. fn_apply_gate_advance: remove SET LOCAL app.gate_bypass ───────────────
-- P3929: Remove `SET LOCAL app.gate_bypass = 'true'` that P3566/mig270 re-added.
-- P906/mig264 already proved this is safe: the gate_decision_log INSERT is in the
-- same transaction, so fn_guard_gate_advance finds the row via same-txn visibility
-- and passes WITHOUT needing the bypass.  Removing it here also means the guard's
-- bypass check (terminal-gates only) is now provably unreachable from this trigger.
-- All other logic (AC-1/2 independence+blocking checks, drift guard, lock, identity
-- attribution, discussion note) is unchanged from mig 270.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_apply_gate_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'roadmap_proposal', 'pg_temp'
AS $function$
DECLARE
    v_proposal          RECORD;
    v_body              TEXT;
    v_prev_identity     TEXT;
    v_author            TEXT;
    v_is_nonterminal    BOOLEAN;
    -- AC-1: independent approve
    v_indep_approve_at  TIMESTAMPTZ;
    v_indep_reviewer    TEXT;
    -- AC-2: unresolved blocking
    v_blocking_newer    BOOLEAN;
BEGIN
    -- Only act on advance decisions; ignore hold/reject/waive/escalate.
    IF NEW.decision != 'advance' THEN
        RETURN NULL;
    END IF;

    v_is_nonterminal := UPPER(NEW.from_state) IN ('DRAFT', 'REVIEW')
                     AND UPPER(NEW.to_state)   IN ('REVIEW', 'DEVELOP');

    -- ── AC-1 / AC-2: Non-terminal gate independence + blocker checks ──────────
    IF v_is_nonterminal THEN
        -- AC-1: find the most-recent approve from an actor independent of decided_by.
        SELECT pr.reviewed_at, pr.reviewer_identity
          INTO v_indep_approve_at, v_indep_reviewer
          FROM roadmap_proposal.proposal_reviews pr
         WHERE pr.proposal_id = NEW.proposal_id
           AND pr.verdict = 'approve'
           AND roadmap_proposal.fn_actor_is_independent(pr.reviewer_identity, NEW.decided_by)
         ORDER BY pr.reviewed_at DESC
         LIMIT 1;

        IF v_indep_approve_at IS NULL THEN
            -- No independent approve: abort the advance, leave a flagged note.
            INSERT INTO roadmap_proposal.proposal_discussions
                (proposal_id, author_identity, context_prefix, body)
            VALUES (
                NEW.proposal_id,
                'system/gate-guard',
                'gate-auth-violation:',
                format(
                    'BLOCKED (AC-1): gate_decision_log id=%s attempted %s→%s (decided_by=%s) '
                    'but no independent approve found in proposal_reviews '
                    '(reviewer must differ from decided_by). '
                    'Submit an approve review from a different actor, then resubmit gate_decision.',
                    NEW.id, NEW.from_state, NEW.to_state, NEW.decided_by
                )
            );
            RETURN NULL;
        END IF;

        -- AC-2: check for a blocking review newer than the independent approve.
        SELECT EXISTS (
            SELECT 1
            FROM roadmap_proposal.proposal_reviews pr
            WHERE pr.proposal_id = NEW.proposal_id
              AND (pr.is_blocking = true OR pr.verdict IN ('request_changes', 'reject'))
              AND pr.reviewed_at > v_indep_approve_at
        ) INTO v_blocking_newer;

        IF v_blocking_newer THEN
            INSERT INTO roadmap_proposal.proposal_discussions
                (proposal_id, author_identity, context_prefix, body)
            VALUES (
                NEW.proposal_id,
                'system/gate-guard',
                'gate-auth-violation:',
                format(
                    'BLOCKED (AC-2): gate_decision_log id=%s attempted %s→%s (decided_by=%s) '
                    'but an unresolved blocking review (is_blocking=true or request_changes/reject) '
                    'exists AFTER the independent approve by %s at %s. '
                    'Resolve the blocking review first (get a newer independent approve), then resubmit.',
                    NEW.id, NEW.from_state, NEW.to_state, NEW.decided_by,
                    v_indep_reviewer, v_indep_approve_at
                )
            );
            RETURN NULL;
        END IF;
    END IF;

    -- ── Resolve the note author (same as mig 270 logic) ──────────────────────
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

    -- P3929 / P906: `SET LOCAL app.gate_bypass = 'true'` removed.
    -- fn_guard_gate_advance finds the gate_decision_log row (inserted in this same
    -- transaction, before this AFTER INSERT trigger runs) via same-txn visibility
    -- and passes WITHOUT the bypass.  This restores the single-writer invariant
    -- (CONVENTIONS.md §6.0b) on both non-terminal AND terminal gate paths.

    -- Attribute the cascaded ledger writes to the real decider.
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
    PERFORM set_config('app.agent_identity', COALESCE(v_prev_identity, ''), true);

    v_body := format(
        'Auto-advanced %s->%s via gate_decision_log id=%s (decided_by: %s, independent_reviewer: %s). '
        'Trigger: fn_apply_gate_advance (P3566/P3929).',
        NEW.from_state, NEW.to_state, NEW.id, NEW.decided_by,
        COALESCE(v_indep_reviewer, 'n/a (terminal gate)')
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

COMMENT ON FUNCTION roadmap_proposal.fn_apply_gate_advance() IS
    'P3566/P204/P3929: Auto-advances proposal.status when gate_decision_log decision=advance fires. '
    'Non-terminal gates (D1 DRAFT→REVIEW, D2 REVIEW→DEVELOP): enforces independent approve (AC-1) '
    'and rejects if a newer unresolved blocking review exists (AC-2). '
    'P3929/P906: SET LOCAL app.gate_bypass removed — same-txn gate_decision_log visibility '
    'makes the bypass unnecessary (single-writer invariant, CONVENTIONS.md §6.0b). '
    'Terminal gates (D3, D4): unchanged pending P3563.';

COMMIT;
