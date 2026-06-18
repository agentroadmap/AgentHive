-- 299-p3929-rollback.sql
-- Rollback for 299-p3929-drop-nonterminal-gate-bypass.sql
-- Restores fn_guard_gate_advance and fn_apply_gate_advance to the mig 270
-- (P3566) definitions (with the app.gate_bypass bypass re-enabled).
--
-- WARNING: applying this rollback re-introduces the P3929 regression:
-- app.gate_bypass='true' will again bypass ALL gate integrity checks on
-- non-terminal gates.  Apply only under operator supervision and plan to
-- re-apply mig 299 as soon as the root cause is resolved.

BEGIN;

-- Restore fn_guard_gate_advance (mig 270 body with early bypass RETURN NEW).
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate_key      TEXT;
    v_has_decision  BOOLEAN;
    v_is_nonterminal BOOLEAN;
BEGIN
    v_gate_key := UPPER(OLD.status) || E'→' || UPPER(NEW.status);

    IF v_gate_key NOT IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE'
    ) THEN
        RETURN NEW;
    END IF;

    -- ROLLBACK: bypass restored (P3929 regression re-introduced).
    IF current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    v_is_nonterminal := v_gate_key IN (E'DRAFT→REVIEW', E'REVIEW→DEVELOP');

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
    'P3566/P290: ROLLBACK STATE — mig 270 body restored. '
    'See 299-p3929-drop-nonterminal-gate-bypass.sql for the fixed version.';

-- Restore fn_apply_gate_advance (mig 270 body with SET LOCAL app.gate_bypass).
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
    v_indep_approve_at  TIMESTAMPTZ;
    v_indep_reviewer    TEXT;
    v_blocking_newer    BOOLEAN;
BEGIN
    IF NEW.decision != 'advance' THEN
        RETURN NULL;
    END IF;

    v_is_nonterminal := UPPER(NEW.from_state) IN ('DRAFT', 'REVIEW')
                     AND UPPER(NEW.to_state)   IN ('REVIEW', 'DEVELOP');

    IF v_is_nonterminal THEN
        SELECT pr.reviewed_at, pr.reviewer_identity
          INTO v_indep_approve_at, v_indep_reviewer
          FROM roadmap_proposal.proposal_reviews pr
         WHERE pr.proposal_id = NEW.proposal_id
           AND pr.verdict = 'approve'
           AND roadmap_proposal.fn_actor_is_independent(pr.reviewer_identity, NEW.decided_by)
         ORDER BY pr.reviewed_at DESC
         LIMIT 1;

        IF v_indep_approve_at IS NULL THEN
            INSERT INTO roadmap_proposal.proposal_discussions
                (proposal_id, author_identity, context_prefix, body)
            VALUES (
                NEW.proposal_id, 'system/gate-guard', 'gate-auth-violation:',
                format('BLOCKED (AC-1): gate_decision_log id=%s attempted %s→%s (decided_by=%s) '
                       'but no independent approve found in proposal_reviews.',
                       NEW.id, NEW.from_state, NEW.to_state, NEW.decided_by)
            );
            RETURN NULL;
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM roadmap_proposal.proposal_reviews pr
            WHERE pr.proposal_id = NEW.proposal_id
              AND (pr.is_blocking = true OR pr.verdict IN ('request_changes', 'reject'))
              AND pr.reviewed_at > v_indep_approve_at
        ) INTO v_blocking_newer;

        IF v_blocking_newer THEN
            INSERT INTO roadmap_proposal.proposal_discussions
                (proposal_id, author_identity, context_prefix, body)
            VALUES (
                NEW.proposal_id, 'system/gate-guard', 'gate-auth-violation:',
                format('BLOCKED (AC-2): gate_decision_log id=%s attempted %s→%s (decided_by=%s) '
                       'but an unresolved blocking review exists AFTER the independent approve by %s at %s.',
                       NEW.id, NEW.from_state, NEW.to_state, NEW.decided_by,
                       v_indep_reviewer, v_indep_approve_at)
            );
            RETURN NULL;
        END IF;
    END IF;

    IF NEW.decided_by IS NOT NULL AND EXISTS (
        SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_identity = NEW.decided_by
    ) THEN
        v_author := NEW.decided_by;
    ELSE
        v_author := 'system/auto-advance';
    END IF;

    SET LOCAL lock_timeout = '5s';
    SELECT id, status, maturity INTO v_proposal
      FROM roadmap_proposal.proposal WHERE id = NEW.proposal_id FOR UPDATE;

    IF NOT FOUND THEN RETURN NULL; END IF;
    IF UPPER(v_proposal.status) = UPPER(NEW.to_state) THEN RETURN NULL; END IF;

    IF UPPER(v_proposal.status) != UPPER(NEW.from_state) THEN
        INSERT INTO roadmap_proposal.proposal_discussions
            (proposal_id, author_identity, context_prefix, body)
        VALUES (
            NEW.proposal_id, v_author, 'gate-decision:',
            format('WARNING: gate_decision_log id=%s expects from=%s but proposal.status=%s (to=%s). No action.',
                   NEW.id, NEW.from_state, v_proposal.status, NEW.to_state)
        );
        RETURN NULL;
    END IF;

    -- ROLLBACK: bypass re-added (P3929 regression re-introduced).
    SET LOCAL app.gate_bypass = 'true';

    v_prev_identity := current_setting('app.agent_identity', true);
    IF NEW.decided_by IS NOT NULL AND EXISTS (
        SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_identity = NEW.decided_by
    ) THEN
        PERFORM set_config('app.agent_identity', NEW.decided_by, true);
    END IF;

    UPDATE roadmap_proposal.proposal SET status = NEW.to_state, maturity = 'new'
     WHERE id = NEW.proposal_id;

    PERFORM set_config('app.agent_identity', COALESCE(v_prev_identity, ''), true);

    v_body := format(
        'Auto-advanced %s->%s via gate_decision_log id=%s (decided_by: %s, independent_reviewer: %s). '
        'Trigger: fn_apply_gate_advance (P3566 ROLLBACK).',
        NEW.from_state, NEW.to_state, NEW.id, NEW.decided_by,
        COALESCE(v_indep_reviewer, 'n/a (terminal gate)')
    );

    INSERT INTO roadmap_proposal.proposal_discussions
        (proposal_id, author_identity, context_prefix, body)
    VALUES (NEW.proposal_id, v_author, 'gate-decision:', v_body);

    RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION roadmap_proposal.fn_apply_gate_advance() IS
    'P3566/P204: ROLLBACK STATE — mig 270 body restored. '
    'See 299-p3929-drop-nonterminal-gate-bypass.sql for the fixed version.';

COMMIT;
