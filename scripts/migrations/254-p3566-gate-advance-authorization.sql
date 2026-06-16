-- Migration 254 — P3566: Gate-advance authorization integrity (non-terminal gates)
--
-- Problem (P3535 incident, 2026-06-16):
--   'claude-workspace-maintainer' self-approved (proposal_reviews verdict='approve')
--   then advanced REVIEW→DEVELOP 9s later with NO gate_decision_log row.
--   A blocking request_changes review filed 7 min later was silently ignored.
--
-- Changes:
--   1. roadmap.fn_actor_is_independent — shared SQL helper (consumed by both
--      this migration's non-terminal branch AND the future P3563 terminal branch).
--      Returns TRUE when an independent approve (reviewer_identity ≠ advancing actor)
--      exists within the time window.
--
--   2. fn_guard_nonterminal_gate_advance_on_decision — BEFORE INSERT trigger on
--      roadmap_proposal.gate_decision_log.  For 'advance' decisions on DRAFT→REVIEW
--      or REVIEW→DEVELOP gates, enforces:
--        • AC-1: independent approver (reviewer_identity ≠ decided_by)
--        • AC-2: no unresolved blocking review
--
--   3. fn_guard_gate_advance (migration 040, CREATE OR REPLACE):
--      For non-terminal gates (DRAFT→REVIEW, REVIEW→DEVELOP) when bypass is NOT set:
--        • Removes the bare-approve bypass (old lines 60-71) — AC-3
--        • Requires a gate_decision_log 'advance' row with decided_by ≠ advancing actor
--        • Rejects if unresolved blocking review present
--      Terminal gates (DEVELOP→MERGE, MERGE→COMPLETE) keep existing behaviour;
--      P3563 will add terminal-gate enforcement via a coordinated rewrite.
--
--   4. fn_reconcile_late_blocking_review — AFTER INSERT trigger on
--      roadmap_proposal.proposal_reviews.  When a blocking review (is_blocking=true
--      OR verdict in {request_changes, reject}) is inserted for a proposal that has
--      already left REVIEW (status IN DEVELOP, MERGE, COMPLETE), it writes an
--      operator-visible discussion entry.  Auto-send-back (status→prior, maturity→new)
--      is available behind SET LOCAL app.gate_late_block_auto_sendback = 'true'.
--
-- Idempotent: all functions are CREATE OR REPLACE; triggers use DROP IF EXISTS first.
-- Preflight: asserts that roadmap_proposal.fn_guard_gate_advance exists (migration 040
-- must be applied) and that proposal_reviews has reviewer_identity + is_blocking columns.
-- Ledger: recorded manually (applied outside normal migration runner if needed).

BEGIN;

-- ─── 0. Preflight assertions ─────────────────────────────────────────────────

DO $$
BEGIN
    -- fn_guard_gate_advance must exist (migration 040)
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'roadmap_proposal' AND p.proname = 'fn_guard_gate_advance'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: roadmap_proposal.fn_guard_gate_advance not found — apply migration 040 first';
    END IF;

    -- proposal_reviews.reviewer_identity column must exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap_proposal'
          AND table_name = 'proposal_reviews'
          AND column_name = 'reviewer_identity'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: roadmap_proposal.proposal_reviews.reviewer_identity column missing';
    END IF;

    -- proposal_reviews.is_blocking column must exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap_proposal'
          AND table_name = 'proposal_reviews'
          AND column_name = 'is_blocking'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: roadmap_proposal.proposal_reviews.is_blocking column missing';
    END IF;
END;
$$;

-- ─── 1. Shared independence helper (roadmap schema — shared with P3563) ───────

CREATE OR REPLACE FUNCTION roadmap.fn_actor_is_independent(
    p_proposal_id     bigint,
    p_advancing_actor text,
    p_window_minutes  int DEFAULT 10
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = roadmap_proposal, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = p_proposal_id
          AND pr.verdict = 'approve'
          AND pr.reviewed_at >= now() - (p_window_minutes || ' minutes')::interval
          AND (
              p_advancing_actor IS NULL
              OR p_advancing_actor = ''
              OR pr.reviewer_identity IS DISTINCT FROM p_advancing_actor
          )
    )
$$;

COMMENT ON FUNCTION roadmap.fn_actor_is_independent(bigint, text, int) IS
    'P3566/P3563 shared helper: returns TRUE when an independent approve '
    '(reviewer_identity ≠ p_advancing_actor) exists within p_window_minutes. '
    'Called by both non-terminal (P3566) and terminal (P3563) gate branches.';

GRANT EXECUTE ON FUNCTION roadmap.fn_actor_is_independent(bigint, text, int)
    TO agent_read, agent_write;

-- ─── 2. Shared unresolved-blocking helper ────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_has_unresolved_blocking(
    p_proposal_id     bigint,
    p_advancing_actor text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = roadmap_proposal, pg_temp
AS $$
    -- Returns TRUE if a blocking review exists that has NOT been superseded
    -- by a later independent approve.
    -- Blocking = is_blocking=true OR verdict IN ('request_changes','reject').
    -- Superseded = a proposal_reviews row with verdict='approve',
    --              reviewer_identity ≠ p_advancing_actor,
    --              reviewed_at strictly after the blocking review.
    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = p_proposal_id
          AND (
              pr.is_blocking = true
              OR pr.verdict IN ('request_changes', 'reject')
          )
          AND NOT EXISTS (
              SELECT 1
              FROM roadmap_proposal.proposal_reviews pr2
              WHERE pr2.proposal_id = pr.proposal_id
                AND pr2.verdict = 'approve'
                AND (
                    p_advancing_actor IS NULL
                    OR p_advancing_actor = ''
                    OR pr2.reviewer_identity IS DISTINCT FROM p_advancing_actor
                )
                AND pr2.reviewed_at > pr.reviewed_at
          )
    )
$$;

COMMENT ON FUNCTION roadmap.fn_has_unresolved_blocking(bigint, text) IS
    'P3566 helper: returns TRUE when a blocking review (is_blocking=true or '
    'verdict request_changes/reject) exists and has not been superseded by a '
    'later independent approve (reviewer_identity ≠ p_advancing_actor).';

GRANT EXECUTE ON FUNCTION roadmap.fn_has_unresolved_blocking(bigint, text)
    TO agent_read, agent_write;

-- ─── 3. BEFORE INSERT guard on gate_decision_log (non-terminal gates) ─────────
--
-- This is the hard enforcement point for the gate_decision_log→fn_apply_gate_advance
-- path.  fn_apply_gate_advance sets app.gate_bypass='true' before the UPDATE, so
-- fn_guard_gate_advance (on proposal) is bypassed on that path.  This trigger
-- enforces AC-1 (independent approver) and AC-2 (no unresolved blocking) at the
-- INSERT layer — before the bypass fires.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_nonterminal_gate_advance_on_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, roadmap, pg_temp
AS $$
DECLARE
    v_gate_key text;
    v_is_independent boolean;
    v_has_blocking   boolean;
BEGIN
    -- Only act on 'advance' decisions for non-terminal gates
    IF NEW.decision != 'advance' THEN
        RETURN NEW;
    END IF;

    v_gate_key := UPPER(COALESCE(NEW.from_state, '')) || E'→' || UPPER(COALESCE(NEW.to_state, ''));

    IF v_gate_key NOT IN (E'DRAFT→REVIEW', E'REVIEW→DEVELOP') THEN
        RETURN NEW;
    END IF;

    -- Allow explicit system bypass (e.g. test setup, operator emergency)
    IF current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    -- AC-1: Independent approver required
    v_is_independent := roadmap.fn_actor_is_independent(NEW.proposal_id, NEW.decided_by);

    IF NOT v_is_independent THEN
        RAISE EXCEPTION
            'Gate advance %→% on proposal % rejected: no independent approve found '
            '(reviewer_identity must differ from decided_by=%). '
            'Have a reviewer distinct from the gate decider submit an approve verdict '
            'via submit_review before calling gate_decision.',
            NEW.from_state, NEW.to_state, NEW.proposal_id, COALESCE(NEW.decided_by, '<null>')
            USING ERRCODE = 'check_violation';
    END IF;

    -- AC-2: No unresolved blocking review
    v_has_blocking := roadmap.fn_has_unresolved_blocking(NEW.proposal_id, NEW.decided_by);

    IF v_has_blocking THEN
        RAISE EXCEPTION
            'Gate advance %→% on proposal % rejected: unresolved blocking review present '
            '(is_blocking=true or verdict request_changes/reject not superseded by '
            'a later independent approve). Resolve blocking feedback before advancing.',
            NEW.from_state, NEW.to_state, NEW.proposal_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_nonterminal_gate_advance
    ON roadmap_proposal.gate_decision_log;

CREATE TRIGGER trg_guard_nonterminal_gate_advance
    BEFORE INSERT ON roadmap_proposal.gate_decision_log
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_guard_nonterminal_gate_advance_on_decision();

COMMENT ON FUNCTION roadmap_proposal.fn_guard_nonterminal_gate_advance_on_decision() IS
    'P3566: BEFORE INSERT on gate_decision_log. For advance decisions on non-terminal '
    'gates (DRAFT→REVIEW, REVIEW→DEVELOP) enforces: AC-1 independent approver, '
    'AC-2 no unresolved blocking review. Bypassed by app.gate_bypass=true (operator use).';

-- ─── 4. Updated fn_guard_gate_advance (replaces migration 040 non-terminal branch) ──
--
-- For non-terminal gates (DRAFT→REVIEW, REVIEW→DEVELOP):
--   • Removes the bare-approve bypass (old migration-040 lines 60-71) — AC-3.
--   • Requires a gate_decision_log 'advance' row with decided_by ≠ advancing actor.
--   • Rejects if unresolved blocking review present.
-- Terminal gates (DEVELOP→MERGE, MERGE→COMPLETE) retain migration-040 behaviour.
-- P3563 will rewrite the terminal branch in a future coordinated migration.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, roadmap, pg_temp
AS $$
DECLARE
    v_gate_key        TEXT;
    v_has_decision    BOOLEAN;
    v_advancing_actor TEXT;
    v_has_blocking    BOOLEAN;
BEGIN
    -- Only act on forward gated status changes
    v_gate_key := UPPER(OLD.status) || E'→' || UPPER(NEW.status);

    IF v_gate_key NOT IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE'
    ) THEN
        RETURN NEW;
    END IF;

    -- Allow orchestrator / fn_apply_gate_advance bypass within an explicit transaction
    IF current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    -- ── Non-terminal gates: P3566 enforcement ───────────────────────────────
    IF v_gate_key IN (E'DRAFT→REVIEW', E'REVIEW→DEVELOP') THEN

        v_advancing_actor := NULLIF(current_setting('app.agent_identity', true), '');

        -- AC-3 + AC-1: require gate_decision_log 'advance' row with independent decided_by.
        -- (The bare proposal_reviews approve bypass from migration 040:60-71 is removed.)
        SELECT EXISTS (
            SELECT 1
            FROM roadmap_proposal.gate_decision_log gdl
            WHERE gdl.proposal_id = NEW.id
              AND UPPER(gdl.from_state) = UPPER(OLD.status)
              AND UPPER(gdl.to_state)   = UPPER(NEW.status)
              AND gdl.decision = 'advance'
              AND gdl.created_at >= now() - INTERVAL '10 minutes'
              AND (
                  v_advancing_actor IS NULL
                  OR gdl.decided_by IS DISTINCT FROM v_advancing_actor
              )
        ) INTO v_has_decision;

        IF NOT v_has_decision THEN
            RAISE EXCEPTION
                'Gate transition % → % on proposal % requires an INDEPENDENT gate decision. '
                'Use gate_decision (MCP action) to record an advance with a decided_by '
                'distinct from the advancing actor (%). '
                'A bare proposal_reviews approve is no longer sufficient — a gate_decision_log '
                'row is required and the decider must differ from the actor advancing status.',
                OLD.status, NEW.status, NEW.id,
                COALESCE(v_advancing_actor, '<unknown>')
                USING ERRCODE = 'check_violation';
        END IF;

        -- AC-2: No unresolved blocking review
        v_has_blocking := roadmap.fn_has_unresolved_blocking(NEW.id, v_advancing_actor);

        IF v_has_blocking THEN
            RAISE EXCEPTION
                'Gate transition % → % on proposal % blocked by unresolved blocking review '
                '(is_blocking=true or verdict request_changes/reject not superseded). '
                'Resolve all blocking feedback before advancing.',
                OLD.status, NEW.status, NEW.id
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    END IF;

    -- ── Terminal gates: retain migration-040 behaviour (P3563 will replace) ──
    -- Check gate_decision_log for a recent 'advance' decision
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

    -- Fallback: bare proposal_reviews approve (terminal gates only; kept for P3563 transition)
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

-- Trigger already exists from migration 040; replace function in place.
-- If trigger was dropped, recreate:
DROP TRIGGER IF EXISTS trg_guard_gate_advance ON roadmap_proposal.proposal;

CREATE TRIGGER trg_guard_gate_advance
    BEFORE UPDATE OF status ON roadmap_proposal.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_guard_gate_advance();

COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
    'P290 (migration 040) + P3566 (migration 254): Enforces gated status transitions. '
    'Non-terminal gates (DRAFT→REVIEW, REVIEW→DEVELOP): requires gate_decision_log '
    'advance row with independent decided_by and no unresolved blocking review. '
    'Terminal gates retain migration-040 behaviour pending P3563. '
    'Bypass with SET LOCAL app.gate_bypass = ''true'' inside a transaction.';

-- ─── 5. Late-blocking-review reconcile trigger (AC-4) ────────────────────────

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_reconcile_late_blocking_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, pg_temp
AS $$
DECLARE
    v_proposal_status text;
    v_send_back       boolean;
BEGIN
    -- Only act on blocking reviews
    IF NOT (NEW.is_blocking = true OR NEW.verdict IN ('request_changes', 'reject')) THEN
        RETURN NEW;
    END IF;

    -- Read current proposal status
    SELECT status
      INTO v_proposal_status
      FROM roadmap_proposal.proposal
     WHERE id = NEW.proposal_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Only flag if the proposal has already advanced beyond REVIEW
    IF UPPER(v_proposal_status) NOT IN ('DEVELOP', 'MERGE', 'COMPLETE') THEN
        RETURN NEW;
    END IF;

    -- Write operator-visible flag discussion entry
    INSERT INTO roadmap_proposal.proposal_discussions
        (proposal_id, author_identity, context_prefix, body)
    VALUES (
        NEW.proposal_id,
        'system/reconciler',
        'gate-late-block:',
        format(
            'LATE BLOCKING REVIEW (P3566 AC-4): proposal already in %s when blocking '
            'review id=%s (verdict=%s, is_blocking=%s, reviewer=%s) was filed. '
            'Manual operator review required. '
            'Auto-send-back disabled (set app.gate_late_block_auto_sendback=true to enable).',
            v_proposal_status,
            NEW.id,
            COALESCE(NEW.verdict, '<null>'),
            COALESCE(NEW.is_blocking::text, 'false'),
            COALESCE(NEW.reviewer_identity, '<unknown>')
        )
    );

    -- Auto-send-back behind operator flag (non-destructive default = flag only)
    v_send_back := current_setting('app.gate_late_block_auto_sendback', true) = 'true';

    IF v_send_back THEN
        -- Send proposal back to REVIEW state with maturity=new
        UPDATE roadmap_proposal.proposal
           SET status  = 'REVIEW',
               maturity = 'new',
               modified_at = NOW()
         WHERE id = NEW.proposal_id
           AND UPPER(status) IN ('DEVELOP', 'MERGE');  -- never auto-revert COMPLETE

        IF FOUND THEN
            INSERT INTO roadmap_proposal.proposal_discussions
                (proposal_id, author_identity, context_prefix, body)
            VALUES (
                NEW.proposal_id,
                'system/reconciler',
                'gate-late-block:',
                format(
                    'AUTO-SENT-BACK to REVIEW: late blocking review id=%s (reviewer=%s) '
                    'triggered status rollback (app.gate_late_block_auto_sendback=true). '
                    'Maturity set to new for re-review.',
                    NEW.id,
                    COALESCE(NEW.reviewer_identity, '<unknown>')
                )
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconcile_late_blocking_review
    ON roadmap_proposal.proposal_reviews;

CREATE TRIGGER trg_reconcile_late_blocking_review
    AFTER INSERT ON roadmap_proposal.proposal_reviews
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_reconcile_late_blocking_review();

COMMENT ON FUNCTION roadmap_proposal.fn_reconcile_late_blocking_review() IS
    'P3566 AC-4: AFTER INSERT on proposal_reviews. When a blocking review is filed '
    'for a proposal already in DEVELOP/MERGE/COMPLETE, writes an operator-visible '
    'discussion flag. Auto-send-back (to REVIEW, maturity=new) is available behind '
    'SET LOCAL app.gate_late_block_auto_sendback = ''true''.';

-- ─── 6. Grants ───────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION roadmap_proposal.fn_guard_gate_advance()
    TO agent_read, agent_write;

GRANT EXECUTE ON FUNCTION roadmap_proposal.fn_guard_nonterminal_gate_advance_on_decision()
    TO agent_read, agent_write;

GRANT EXECUTE ON FUNCTION roadmap_proposal.fn_reconcile_late_blocking_review()
    TO agent_read, agent_write;

COMMIT;
