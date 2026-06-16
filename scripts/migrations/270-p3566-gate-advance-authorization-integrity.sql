-- 270-p3566-gate-advance-authorization-integrity.sql
-- P3566: Gate-advance authorization integrity for non-terminal gates (D1, D2).
--
-- Closes three holes confirmed by the P3535 incident (2026-06-16 02:59):
--   1. Self-approve: proposal_reviews branch had no independence check.
--   2. Unresolved blocker: no check for request_changes/reject after the approve.
--   3. No mandatory audit row: bare approve substituted for gate_decision_log.
-- Adds late-blocking TOCTOU reconcile (AC-4) and a shared independence helper (AC-5).
--
-- Changes (all idempotent, CREATE OR REPLACE):
--   A. fn_actor_is_independent(p_reviewer, p_advancer) → shared boolean helper (AC-5)
--      Used by both the non-terminal branch here and the terminal branch (P3563).
--   B. fn_guard_gate_advance (040 replacement):
--      - Non-terminal gates (D1 DRAFT→REVIEW, D2 REVIEW→DEVELOP): drops the bare
--        proposal_reviews approve branch; gate_decision_log advance row is now the
--        ONLY accepted evidence (AC-3). Direct prop_transition on a gated edge raises
--        a helpful error directing callers to use record_gate_decision instead.
--      - Terminal gates (D3, D4): no change (P3563 domain).
--   C. fn_apply_gate_advance (204 replacement):
--      For non-terminal gates, before advancing:
--        i.  Requires an independent approve in proposal_reviews
--            (reviewer_identity != NEW.decided_by) — AC-1.
--        ii. Rejects if a newer unresolved blocking review exists
--            (is_blocking=true OR verdict IN (request_changes, reject))
--            that was not superseded by a later independent approve — AC-2.
--      On violation: inserts a flagged discussion row and returns NULL
--      (advance silently aborted; caller must resolve and resubmit).
--   D. fn_reconcile_late_blocking_review + trg_reconcile_late_blocking_review:
--      AFTER INSERT on proposal_reviews. If the new review is blocking and the
--      proposal already advanced PAST the state it was in at review time, inserts
--      a flagged discussion row (AC-4). Auto-send-back controlled by
--      current_setting('app.late_blocking_auto_sendback', true) = 'true'.
--
-- Preflight: asserts fn_guard_gate_advance exists (prerequisite 040 applied).
-- Prerequisite order: 040 → 059 → 204 → THIS.
-- Coordinates with P3563 (terminal gates): both call fn_actor_is_independent.

BEGIN;

-- ─── EXTEND context_prefix CONSTRAINT ────────────────────────────────────────
-- Add 'gate-auth-violation:' and 'gate-toctou-flag:' to the allowed list so
-- the violation / TOCTOU flag discussion notes can be inserted.

DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    -- Read the current constraint definition.
    SELECT pg_get_constraintdef(oid)
      INTO v_constraint
      FROM pg_constraint
     WHERE conname = 'proposal_discussions_context_check';

    -- Skip if the constraint already includes the new prefixes (idempotent).
    IF v_constraint LIKE '%gate-auth-violation%' THEN
        RETURN;
    END IF;

    ALTER TABLE roadmap_proposal.proposal_discussions
        DROP CONSTRAINT IF EXISTS proposal_discussions_context_check;

    ALTER TABLE roadmap_proposal.proposal_discussions
        ADD CONSTRAINT proposal_discussions_context_check
        CHECK (context_prefix = ANY (ARRAY[
            'arch:', 'team:', 'critical:', 'security:', 'general:', 'feedback:',
            'concern:', 'poc:', 'decision:', 'ship-verification:', 'gate-decision:',
            'handoff:', 'lease-overrun', 'e2e-verify', 'e2e-verify-failed',
            'gate-auth-violation:', 'gate-toctou-flag:'
        ]));
END;
$$;

-- ─── PREFLIGHT ────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'roadmap_proposal'
           AND p.proname = 'fn_guard_gate_advance'
    ) THEN
        RAISE EXCEPTION 'Prerequisite 040-p290-gate-enforcement.sql not applied: '
            'roadmap_proposal.fn_guard_gate_advance() missing.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'roadmap_proposal'
           AND p.proname = 'fn_apply_gate_advance'
    ) THEN
        RAISE EXCEPTION 'Prerequisite 059-p611-gate-decision-auto-advance.sql not applied: '
            'roadmap_proposal.fn_apply_gate_advance() missing.';
    END IF;
END;
$$;

-- ─── AC-5: SHARED INDEPENDENCE HELPER ─────────────────────────────────────────
-- Returns TRUE when the reviewer/verifier is independent of the advancing actor.
-- Floor rule: distinct non-null session identity strings.
-- Called by both non-terminal (P3566) and terminal (P3563) gate branches.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_actor_is_independent(
    p_reviewer TEXT,
    p_advancer TEXT
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    -- Both must be non-null and non-empty, and must differ.
    RETURN p_reviewer IS NOT NULL
        AND p_advancer IS NOT NULL
        AND p_reviewer <> ''
        AND p_advancer <> ''
        AND p_reviewer <> p_advancer;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_actor_is_independent(TEXT, TEXT) IS
    'P3566/AC-5: Reviewer is independent of the advancing actor when both identities '
    'are non-empty and distinct. Floor rule for single-agency setups. '
    'Called by both non-terminal (P3566) and terminal (P3563) gate guard branches.';

-- ─── AC-3 / (partial AC-1, AC-2): REVISED fn_guard_gate_advance ───────────────
-- Non-terminal gates (D1, D2) no longer accept a bare proposal_reviews approve
-- as a substitute for a gate_decision_log row.  The fn_apply_gate_advance trigger
-- is the only path that may advance DRAFT→REVIEW or REVIEW→DEVELOP (it sets
-- app.gate_bypass = 'true').  Any direct status UPDATE on a non-terminal gated
-- edge without a matching gate_decision_log row raises a helpful error.
--
-- Terminal gates (D3, D4) retain the existing dual-branch logic unchanged.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate_key      TEXT;
    v_has_decision  BOOLEAN;
    v_is_nonterminal BOOLEAN;
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

    -- Allow fn_apply_gate_advance's intra-transaction bypass (set LOCAL by that trigger).
    IF current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    v_is_nonterminal := v_gate_key IN (E'DRAFT→REVIEW', E'REVIEW→DEVELOP');

    -- ── Non-terminal gates (D1, D2): ONLY gate_decision_log advance row is accepted.
    -- The bare proposal_reviews approve branch is intentionally REMOVED (AC-3).
    -- Callers must use record_gate_decision (which triggers fn_apply_gate_advance →
    -- bypasses back in here). A direct UPDATE without that log row is rejected.
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

    -- ── Terminal gates (D3, D4): retain original dual-branch logic ──────────────

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
    'P3566/P290: Enforces that gated status transitions require authorization. '
    'Non-terminal gates (D1, D2): only gate_decision_log advance row accepted (bare '
    'proposal_reviews approve removed — AC-3). Terminal gates (D3, D4): dual-branch '
    'unchanged pending P3563. Independence + blocking checks enforced in fn_apply_gate_advance.';

-- ─── AC-1 / AC-2: REVISED fn_apply_gate_advance ───────────────────────────────
-- For non-terminal gates (D1 DRAFT→REVIEW, D2 REVIEW→DEVELOP), before advancing:
--   AC-1: requires an independent approve in proposal_reviews
--         (reviewer_identity != NEW.decided_by via fn_actor_is_independent).
--   AC-2: rejects if a newer unresolved blocking review exists
--         (is_blocking=true OR verdict IN {request_changes,reject}) that postdates
--         the satisfying independent approve.
-- On violation: inserts a flagged discussion note and returns NULL (no status flip).
-- Terminal gates (D3, D4): unchanged (advance proceeds as before).

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

    -- ── Resolve the note author (same as 204 logic) ───────────────────────────
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

    -- Bypass fn_guard_gate_advance for this transaction; SET LOCAL is transaction-scoped.
    SET LOCAL app.gate_bypass = 'true';

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
        'Trigger: fn_apply_gate_advance (P3566).',
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
    'P3566/P204: Auto-advances proposal.status when gate_decision_log decision=advance fires. '
    'Non-terminal gates (D1 DRAFT→REVIEW, D2 REVIEW→DEVELOP): enforces independent approve (AC-1) '
    'and rejects if a newer unresolved blocking review exists (AC-2). '
    'Terminal gates (D3, D4): unchanged pending P3563.';

-- ─── AC-4: LATE-BLOCKING TOCTOU RECONCILE ─────────────────────────────────────
-- Trigger on proposal_reviews INSERT: if the new review is blocking and the proposal
-- has already advanced past the state it was in when the review was submitted,
-- flag the proposal with a discussion note.
-- Auto-send-back (status→prior, maturity→new) is disabled by default and controlled
-- by: SET LOCAL app.late_blocking_auto_sendback = 'true' in the caller's transaction.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_reconcile_late_blocking_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'roadmap_proposal', 'pg_temp'
AS $$
DECLARE
    v_prop           RECORD;
    v_gate_order     INT;
    v_review_gate    INT;
    v_sendback       BOOLEAN := false;
    v_from_state     TEXT;
    v_prior_state    TEXT;
    v_author         TEXT;
BEGIN
    -- Only act on blocking reviews or request_changes/reject verdicts.
    IF NOT (NEW.is_blocking = true OR NEW.verdict IN ('request_changes', 'reject')) THEN
        RETURN NEW;
    END IF;

    -- Fetch current proposal state.
    SELECT status, maturity
      INTO v_prop
      FROM roadmap_proposal.proposal
     WHERE id = NEW.proposal_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Resolve ordered gate index so we can compare "ahead" easily.
    -- DRAFT=0, REVIEW=1, DEVELOP=2, MERGE=3, COMPLETE=4
    v_gate_order := CASE UPPER(v_prop.status)
        WHEN 'DRAFT'     THEN 0
        WHEN 'REVIEW'    THEN 1
        WHEN 'DEVELOP'   THEN 2
        WHEN 'MERGE'     THEN 3
        WHEN 'COMPLETE'  THEN 4
        ELSE                  -1
    END;

    -- Determine the state the proposal was in BEFORE the most-recent advance
    -- that occurred before this review was submitted.
    -- Use from_state (not to_state) so we compare "what state was it in before
    -- the advance that raced this review", not "what state it moved to".
    -- Example: DRAFT→REVIEW advance before review → v_from_state='DRAFT',
    -- proposal now at REVIEW (gate_order=1 > review_gate=0) → flag.
    SELECT COALESCE(
        (SELECT UPPER(gdl.from_state)
           FROM roadmap_proposal.gate_decision_log gdl
          WHERE gdl.proposal_id = NEW.proposal_id
            AND gdl.decision = 'advance'
            AND gdl.created_at < NEW.reviewed_at
          ORDER BY gdl.created_at DESC
          LIMIT 1),
        'DRAFT'
    ) INTO v_from_state;

    v_review_gate := CASE v_from_state
        WHEN 'DRAFT'     THEN 0
        WHEN 'REVIEW'    THEN 1
        WHEN 'DEVELOP'   THEN 2
        WHEN 'MERGE'     THEN 3
        WHEN 'COMPLETE'  THEN 4
        ELSE                  0
    END;

    -- If the proposal is already ahead of where it was when the blocking review
    -- was submitted, this is a TOCTOU case — the advance raced the review.
    IF v_gate_order <= v_review_gate THEN
        RETURN NEW;  -- not ahead, no action needed
    END IF;

    -- Resolve author for the flagging note.
    IF NEW.reviewer_identity IS NOT NULL AND EXISTS (
        SELECT 1 FROM roadmap_workforce.agent_registry
         WHERE agent_identity = NEW.reviewer_identity
    ) THEN
        v_author := NEW.reviewer_identity;
    ELSE
        v_author := 'system/gate-reconcile';
    END IF;

    -- Check auto-send-back flag (operator opt-in per transaction).
    v_sendback := current_setting('app.late_blocking_auto_sendback', true) = 'true';

    -- Flag: insert a discussion note.
    INSERT INTO roadmap_proposal.proposal_discussions
        (proposal_id, author_identity, context_prefix, body)
    VALUES (
        NEW.proposal_id,
        v_author,
        'gate-toctou-flag:',
        format(
            'TOCTOU WARNING (AC-4 / P3566): blocking review (id=%s, verdict=%s, is_blocking=%s) '
            'from %s arrived AFTER proposal already advanced past %s (current=%s). '
            'The advance raced this review. %s',
            NEW.id, NEW.verdict, NEW.is_blocking, NEW.reviewer_identity,
            v_from_state, v_prop.status,
            CASE WHEN v_sendback
                THEN 'Auto-send-back ENABLED: reverting to ' || v_from_state || ', maturity=new.'
                ELSE 'Auto-send-back DISABLED. Operator: inspect and manually send back if needed.'
            END
        )
    );

    -- Optional auto-send-back (behind operator flag).
    IF v_sendback THEN
        -- Determine prior state to send back to.
        v_prior_state := CASE v_from_state
            WHEN 'REVIEW'   THEN 'REVIEW'    -- was in REVIEW when reviewed → send back to REVIEW
            WHEN 'DEVELOP'  THEN 'DEVELOP'
            ELSE v_from_state
        END;

        SET LOCAL app.gate_bypass = 'true';

        UPDATE roadmap_proposal.proposal
           SET status   = v_prior_state,
               maturity = 'new'
         WHERE id = NEW.proposal_id;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_reconcile_late_blocking_review() IS
    'P3566/AC-4: Fires AFTER INSERT on proposal_reviews. If a blocking/request_changes '
    'review arrives after the proposal already advanced past that review state, flags '
    'the proposal with a TOCTOU warning discussion note. Auto-send-back enabled when '
    'app.late_blocking_auto_sendback = true (operator opt-in per transaction).';

DROP TRIGGER IF EXISTS trg_reconcile_late_blocking_review
    ON roadmap_proposal.proposal_reviews;

CREATE TRIGGER trg_reconcile_late_blocking_review
    AFTER INSERT ON roadmap_proposal.proposal_reviews
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_reconcile_late_blocking_review();

COMMENT ON TRIGGER trg_reconcile_late_blocking_review
    ON roadmap_proposal.proposal_reviews IS
    'P3566/AC-4: Late-blocking TOCTOU reconcile. Fires on new blocking reviews; '
    'flags proposals that already advanced past the review state.';

-- ─── GRANTS ───────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION roadmap_proposal.fn_actor_is_independent(TEXT, TEXT)
    TO agent_read, agent_write;

COMMIT;
