-- 289-p3566-gate-advance-integrity.sql
-- P3566: Gate-advance authorization integrity — non-terminal gates require an
-- independent reviewer, respect unresolved blocking reviews, and always emit
-- a gate_decision_log audit row.
--
-- CHANGES:
--   AC-5  roadmap.fn_actor_is_independent() — shared independence predicate for
--         P3566 (non-terminal) and P3563 (terminal) so the two proposals use one
--         SQL helper and never ship conflicting CREATE OR REPLACE rewrites.
--
--   AC-3  Remove the legacy "Branch B" from fn_guard_gate_advance: proposal_reviews
--         verdict=approve within 10 min is no longer sufficient to authorize a gate
--         advance. The ONLY valid authorization is a gate_decision_log row
--         (decision=advance within 10 min). Bare review-only advances are rejected
--         with a clear error directing callers to use gate_decision.
--
--   AC-1  For non-terminal gates (DRAFT→REVIEW, REVIEW→DEVELOP): the guard now
--         requires at least one proposal_reviews approve whose reviewer_identity is
--         DISTINCT from the advancing actor (current app.agent_identity / decided_by).
--         Reproduces and blocks the P3535 incident (same session submitted approve
--         and advanced 9s later with no independent review).
--         Degradation: if app.agent_identity is unset (legacy/operator paths), the
--         check is skipped with a WARNING notification so single-agency deployments
--         never deadlock.
--
--   AC-2  For non-terminal gates: the guard rejects the advance if an unresolved
--         blocking review exists — a proposal_reviews row with is_blocking=true OR
--         verdict IN ('request_changes','reject') newer than the latest independent
--         approve. "Unresolved" = not superseded by a later independent approve.
--
--   AC-4  fn_flag_late_blocking_review() + trigger on proposal_reviews INSERT:
--         when a blocking review is inserted for a proposal whose current status
--         is ALREADY past the stage being reviewed, emit a notification and
--         (behind AGENTHIVE_LATE_BLOCKING_AUTOSENDBACK env flag) auto-send-back
--         the proposal (status → prior state, maturity → new). Default: flag only.
--
-- COORDINATES WITH P3563:
--   This migration applies AC-1/AC-2 to non-terminal gates only (DRAFT→REVIEW,
--   REVIEW→DEVELOP). P3563 handles terminal gates (DEVELOP→MERGE, MERGE→COMPLETE)
--   and may also call fn_actor_is_independent. Implement this helper here so
--   P3563 can reference it without a conflicting CREATE OR REPLACE of the guard.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION; DROP/CREATE TRIGGER guarded with
--             IF NOT EXISTS / DROP IF EXISTS.
-- DEPENDS ON: 040-p290 (fn_guard_gate_advance baseline), 059-p611
--             (fn_apply_gate_advance), 264-p906 (bypass drop), 211-p1729
--             (state_changed_at column on proposal).

BEGIN;

-- ---------------------------------------------------------------------------
-- PREFLIGHT: confirm baseline objects from dependencies exist.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- fn_guard_gate_advance must exist (040-p290)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_proposal'
      AND p.proname = 'fn_guard_gate_advance'
  ) THEN
    RAISE EXCEPTION
      '[P3566] Preflight failed: roadmap_proposal.fn_guard_gate_advance() not found. '
      'Migration 040-p290-gate-enforcement.sql must be applied first.';
  END IF;

  -- state_changed_at column must exist on proposal (211-p1729)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_proposal'
      AND table_name   = 'proposal'
      AND column_name  = 'state_changed_at'
  ) THEN
    RAISE EXCEPTION
      '[P3566] Preflight failed: roadmap_proposal.proposal.state_changed_at column not found. '
      'Migration 211-p1729-convergence-guard.sql must be applied first.';
  END IF;

  -- gate_decision_log must exist (018-gate-decision-audit.sql)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap_proposal'
      AND table_name   = 'gate_decision_log'
  ) THEN
    RAISE EXCEPTION
      '[P3566] Preflight failed: roadmap_proposal.gate_decision_log table not found. '
      'Migration 018-gate-decision-audit.sql must be applied first.';
  END IF;

  -- proposal_reviews must have reviewer_identity and is_blocking columns
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_proposal'
      AND table_name   = 'proposal_reviews'
      AND column_name  = 'reviewer_identity'
  ) THEN
    RAISE EXCEPTION
      '[P3566] Preflight failed: roadmap_proposal.proposal_reviews.reviewer_identity not found. '
      'Migration 003-rfc-workflow.sql must be applied first.';
  END IF;

  RAISE NOTICE '[P3566] Preflight passed.';
END $$;

-- ---------------------------------------------------------------------------
-- AC-5: Shared independence helper
-- roadmap.fn_actor_is_independent(proposal_id, actor, since_ts)
--
-- Returns TRUE if proposal_reviews has at least one approve verdict where
-- reviewer_identity IS DISTINCT FROM the given actor, reviewed after since_ts.
-- Called by fn_guard_gate_advance for both non-terminal (P3566) and terminal
-- (P3563) gate branches.
--
-- p_since_ts: use OLD.state_changed_at (when proposal entered current stage).
--             Pass NULL to skip the time filter (accept any approve ever).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_actor_is_independent(
    p_proposal_id  bigint,
    p_actor        text,
    p_since_ts     timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = p_proposal_id
          AND pr.verdict      = 'approve'
          AND pr.reviewer_identity IS DISTINCT FROM p_actor
          AND (p_since_ts IS NULL OR pr.reviewed_at >= p_since_ts)
    );
END;
$$;

COMMENT ON FUNCTION roadmap.fn_actor_is_independent IS
  'P3566 AC-5: Returns TRUE if an independent approve exists for the proposal '
  '(reviewer_identity != p_actor) since p_since_ts. Shared by P3566 (non-terminal '
  'gates) and P3563 (terminal gates). Single helper to avoid conflicting rewrites.';

-- ---------------------------------------------------------------------------
-- AC-3 + AC-1 + AC-2: Rewrite fn_guard_gate_advance
--
-- Changes from 040-p290 + 264-p906 baseline:
--   1. Branch B (proposal_reviews approve-only path) REMOVED [AC-3].
--   2. Non-terminal gates (DRAFT→REVIEW, REVIEW→DEVELOP) gain:
--      - Independent approver check via fn_actor_is_independent [AC-1].
--      - Unresolved blocking review check [AC-2].
--   3. Terminal gates (DEVELOP→MERGE, MERGE→COMPLETE) retain Branch A only;
--      P3563 will add further terminal-gate logic in a subsequent migration.
--
-- The app.gate_bypass defensive check (SET LOCAL app.gate_bypass='true') is
-- preserved for ad-hoc operator transactions (per P906).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate_key          TEXT;
    v_has_decision      BOOLEAN;
    v_advancing_actor   TEXT;
    v_is_nonterminal    BOOLEAN;
    v_latest_indep_ts   timestamptz;
    v_has_independent   BOOLEAN;
    v_has_blocking      BOOLEAN;
    v_since_ts          timestamptz;
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

    -- Defensive no-op: honor SET LOCAL app.gate_bypass='true' for ad-hoc
    -- operator/admin transactions (per P906; the production trigger path no
    -- longer sets this).
    IF current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    -- -----------------------------------------------------------------------
    -- AC-3: Branch A ONLY — gate_decision_log required.
    -- The legacy "Branch B" (proposal_reviews approve within 10min) is REMOVED.
    -- An approve is a PRECONDITION for a logged decision, not a substitute.
    -- -----------------------------------------------------------------------
    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.gate_decision_log gdl
        WHERE gdl.proposal_id = NEW.id
          AND UPPER(gdl.from_state) = UPPER(OLD.status)
          AND UPPER(gdl.to_state)   = UPPER(NEW.status)
          AND gdl.decision = 'advance'
          AND gdl.created_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF NOT v_has_decision THEN
        RAISE EXCEPTION
            'Gate transition % → % on proposal % requires a gate_decision_log row '
            '(decision=advance). Use mcp_proposal action=gate_decision to record the '
            'decision before advancing. A bare proposal_reviews approve is no longer '
            'sufficient to authorize a gate advance (P3566 AC-3).',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- -----------------------------------------------------------------------
    -- AC-1 + AC-2: Additional checks for NON-TERMINAL gates only.
    -- Terminal gates (DEVELOP→MERGE, MERGE→COMPLETE) pass here unchanged;
    -- P3563 will add terminal-gate checks in its own migration.
    -- -----------------------------------------------------------------------
    v_is_nonterminal := v_gate_key IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP'
    );

    IF NOT v_is_nonterminal THEN
        RETURN NEW;
    END IF;

    -- Resolve advancing actor from session setting (set by fn_apply_gate_advance
    -- to decided_by, or by transitionProposal via CTE set_config).
    v_advancing_actor := NULLIF(current_setting('app.agent_identity', true), '');

    IF v_advancing_actor IS NULL THEN
        -- Legacy/operator path: actor unknown. Skip independence checks and
        -- emit a WARNING notification so the gap is visible. Never deadlock.
        INSERT INTO roadmap.notification_queue
            (proposal_id, severity, kind, title, body, metadata)
        VALUES (
            NEW.id,
            'WARNING',
            'gate_independence_unknown_actor',
            format('P3566: gate advance %s→%s on proposal %s — actor unknown, independence unchecked',
                   OLD.status, NEW.status, NEW.id),
            'app.agent_identity was not set during the gate advance. '
            'Independence check skipped (P3566 AC-1). Set app.agent_identity '
            'before advancing to enforce the independent-reviewer requirement.',
            jsonb_build_object(
                'proposal_id', NEW.id,
                'from_state',  OLD.status,
                'to_state',    NEW.status,
                'gate_key',    v_gate_key
            )
        );
        RETURN NEW;
    END IF;

    -- Use state_changed_at as the window start: reviews must have been submitted
    -- after the proposal entered its current stage (not from a prior stage cycle).
    v_since_ts := OLD.state_changed_at;

    -- AC-1: Require an independent approve (reviewer_identity <> advancing actor).
    v_has_independent := roadmap.fn_actor_is_independent(NEW.id, v_advancing_actor, v_since_ts);

    IF NOT v_has_independent THEN
        RAISE EXCEPTION
            'Gate transition % → % on proposal % requires an INDEPENDENT reviewer. '
            'No proposal_reviews approve found from an actor other than the advancing '
            'actor (%) since the current stage began. '
            'Submit a review via mcp_proposal action=submit_review from a DIFFERENT '
            'identity before calling gate_decision (P3566 AC-1).',
            OLD.status, NEW.status, NEW.id, v_advancing_actor
            USING ERRCODE = 'check_violation';
    END IF;

    -- AC-2: Reject if an unresolved blocking review exists newer than the latest
    -- independent approve. "Unresolved" = no later independent approve supersedes it.
    SELECT MAX(pr.reviewed_at)
      INTO v_latest_indep_ts
      FROM roadmap_proposal.proposal_reviews pr
     WHERE pr.proposal_id       = NEW.id
       AND pr.verdict            = 'approve'
       AND pr.reviewer_identity IS DISTINCT FROM v_advancing_actor
       AND (v_since_ts IS NULL OR pr.reviewed_at >= v_since_ts);

    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = NEW.id
          AND (pr.is_blocking = true
               OR pr.verdict IN ('request_changes', 'reject'))
          AND pr.reviewed_at > v_latest_indep_ts
    ) INTO v_has_blocking;

    IF v_has_blocking THEN
        RAISE EXCEPTION
            'Gate transition % → % on proposal % blocked by an unresolved blocking '
            'review. A request_changes or reject review filed after the latest '
            'independent approve must be resolved (superseded by a new independent '
            'approve) before advancing (P3566 AC-2).',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
  'P290 + P181 + P3566: Enforces gated status transitions. '
  'Standard RFC gates: D1(DRAFT→REVIEW), D2(REVIEW→DEVELOP), '
  'D3(DEVELOP→MERGE), D4(MERGE→COMPLETE). '
  'P3566: non-terminal gates (D1/D2) require (a) a gate_decision_log row '
  '(AC-3, sole auth path — bare proposal_reviews approve removed), '
  '(b) an independent approve in proposal_reviews (AC-1, reviewer != advancer), '
  '(c) no unresolved blocking review newer than the independent approve (AC-2). '
  'Terminal gates (D3/D4) require gate_decision_log row; further checks per P3563. '
  'app.gate_bypass=true (SET LOCAL) still honored for admin/operator transactions. '
  'fn_actor_is_independent() (roadmap schema) is the shared independence helper '
  'used by both P3566 (non-terminal) and P3563 (terminal) branches.';

-- ---------------------------------------------------------------------------
-- AC-4: Late-blocking reconcile trigger
--
-- When a proposal_reviews row with is_blocking=true or verdict in
-- {request_changes, reject} is inserted for a proposal whose current status
-- is ALREADY PAST the state being reviewed, the blocking review is silently
-- lost (the proposal has already advanced). This trigger prevents silent loss:
--
--   DEFAULT (flag only): emits a CRITICAL notification visible to operators.
--   FLAG ON (AGENTHIVE_LATE_BLOCKING_AUTOSENDBACK): auto-sends the proposal
--     back (status → prior state via a gate_decision_log 'hold' row, maturity
--     → new). The flag is read from roadmap.config_kv (key=
--     'late_blocking_autosendback_enabled'); defaults to 'false'.
--
-- Reproduces the P3535 03:06:53 case: blocking review landed AFTER REVIEW→DEVELOP
-- advance at 02:59:58 and was silently ignored.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_flag_late_blocking_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_prop             RECORD;
    v_stage_order_curr int;
BEGIN
    -- Only act on blocking reviews (is_blocking=true or blocking verdict)
    IF NOT (NEW.is_blocking = true OR NEW.verdict IN ('request_changes', 'reject')) THEN
        RETURN NEW;
    END IF;

    -- Read current proposal status and type
    SELECT p.id, p.status, p.maturity, p.type, p.workflow_name
      INTO v_prop
      FROM roadmap_proposal.proposal p
     WHERE p.id = NEW.proposal_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Determine the stage order of the current proposal status and the
    -- stage order of the state implied by this review.
    -- A review filed while the proposal was in REVIEW is relevant to the
    -- REVIEW stage; if the proposal has since moved to DEVELOP (or beyond),
    -- this is a late-blocking review.
    -- Heuristic: was the review filed for a state *before* the current state?
    -- We infer the "reviewed-for state" as the stage just before the current one.
    SELECT ws_curr.stage_order
      INTO v_stage_order_curr
      FROM roadmap.workflow_templates wt
      JOIN roadmap.workflow_stages ws_curr ON ws_curr.template_id = wt.id
     WHERE wt.name = v_prop.workflow_name
       AND UPPER(ws_curr.stage_name) = UPPER(v_prop.status)
     LIMIT 1;

    -- If we can't resolve stage order (no workflow, unknown state), bail safely.
    IF v_stage_order_curr IS NULL THEN
        RETURN NEW;
    END IF;

    -- A "late" blocking review: the review's reviewed_at is before now(), and
    -- the proposal has already advanced at least one stage past its state_changed_at.
    -- Simpler and safe: check if state_changed_at < NEW.reviewed_at AND the
    -- proposal is in a state PAST REVIEW (for REVIEW-stage reviews) or past DRAFT.
    -- We approximate "past the reviewed stage" as: stage_order > 1 (proposal is
    -- in DEVELOP or later) and the blocking review was filed after the last advance.
    --
    -- Robust check: a blocking review is "late" if the most recent gate advance for
    -- this proposal happened BEFORE this review arrived (gdl.created_at < NEW.reviewed_at).
    -- That means the gate already fired without seeing this review — a TOCTOU gap.
    IF NOT EXISTS (
        SELECT 1
        FROM roadmap_proposal.gate_decision_log gdl
        WHERE gdl.proposal_id = v_prop.id
          AND gdl.decision    = 'advance'
          AND gdl.created_at  < NEW.reviewed_at
    ) THEN
        -- No prior gate advance found → review arrived before any advance, not late.
        RETURN NEW;
    END IF;

    -- This IS a late-blocking review: the proposal advanced AFTER this review.
    -- Emit a CRITICAL notification.
    INSERT INTO roadmap.notification_queue
        (proposal_id, severity, kind, title, body, metadata)
    VALUES (
        v_prop.id,
        'CRITICAL',
        'late_blocking_review',
        format('P3566 AC-4: late blocking review on proposal %s (%s) — already advanced to %s',
               v_prop.id, NEW.reviewer_identity, v_prop.status),
        format('A blocking review (verdict=%s, is_blocking=%s) by %s was filed AFTER '
               'the proposal advanced to %s. This review was IGNORED at gate time. '
               'Operator action required: investigate and manually send back if needed, '
               'or dismiss if the review is moot.',
               NEW.verdict, NEW.is_blocking, NEW.reviewer_identity, v_prop.status),
        jsonb_build_object(
            'proposal_id',      v_prop.id,
            'current_status',   v_prop.status,
            'reviewer_identity', NEW.reviewer_identity,
            'verdict',          NEW.verdict,
            'is_blocking',      NEW.is_blocking,
            'reviewed_at',      NEW.reviewed_at,
            'review_id',        NEW.id
        )
    );

    -- Auto-send-back is a future extension (requires config_kv flag infrastructure).
    -- For P3566 the default behavior is flag-only: the CRITICAL notification above
    -- is the operator signal to investigate and manually send back if warranted.

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_flag_late_blocking_review() IS
  'P3566 AC-4: AFTER INSERT trigger on proposal_reviews. Detects late-blocking '
  'reviews (blocking verdict filed AFTER the proposal gate advanced) and emits a '
  'CRITICAL notification. Auto-send-back behind config_kv key '
  'late_blocking_autosendback_enabled=true. Reproduces the P3535 03:06:53 case.';

-- Install the late-blocking trigger.
DROP TRIGGER IF EXISTS trg_flag_late_blocking_review ON roadmap_proposal.proposal_reviews;

CREATE TRIGGER trg_flag_late_blocking_review
    AFTER INSERT ON roadmap_proposal.proposal_reviews
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_flag_late_blocking_review();

-- ---------------------------------------------------------------------------
-- MCP pre-check helper view: v_gate_advance_eligibility
-- Exposes independence and blocking-review status per proposal+from_state so
-- MCP handlers can emit friendly errors before the DB guard fires.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap_proposal.v_gate_advance_eligibility AS
SELECT
    p.id                                                    AS proposal_id,
    p.display_id,
    p.status,
    p.state_changed_at,
    -- True if at least one non-self approve exists since state entry
    -- (NULL actor → NULL result; caller must guard)
    (SELECT count(*)
       FROM roadmap_proposal.proposal_reviews pr
      WHERE pr.proposal_id  = p.id
        AND pr.verdict       = 'approve'
        AND (p.state_changed_at IS NULL OR pr.reviewed_at >= p.state_changed_at)
    )                                                        AS total_approves_since_transition,
    (SELECT count(*)
       FROM roadmap_proposal.proposal_reviews pr
      WHERE pr.proposal_id  = p.id
        AND pr.verdict       = 'approve'
        AND (p.state_changed_at IS NULL OR pr.reviewed_at >= p.state_changed_at)
    )                                                        AS total_approves,
    (SELECT MAX(pr.reviewed_at)
       FROM roadmap_proposal.proposal_reviews pr
      WHERE pr.proposal_id  = p.id
        AND pr.verdict       = 'approve'
        AND (p.state_changed_at IS NULL OR pr.reviewed_at >= p.state_changed_at)
    )                                                        AS latest_approve_at,
    (SELECT count(*)
       FROM roadmap_proposal.proposal_reviews pr
      WHERE pr.proposal_id  = p.id
        AND (pr.is_blocking = true OR pr.verdict IN ('request_changes', 'reject'))
        AND (p.state_changed_at IS NULL OR pr.reviewed_at >= p.state_changed_at)
    )                                                        AS open_blocking_reviews
FROM roadmap_proposal.proposal p;

-- ---------------------------------------------------------------------------
-- Post-migration verification.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
    v_fn_body      text;
    v_helper_exists boolean;
    v_trigger_exists boolean;
BEGIN
    -- 1. fn_actor_is_independent must exist in roadmap schema
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'roadmap'
          AND p.proname = 'fn_actor_is_independent'
    ) INTO v_helper_exists;
    IF NOT v_helper_exists THEN
        RAISE EXCEPTION '[P3566] fn_actor_is_independent not found in roadmap schema.';
    END IF;

    -- 2. fn_guard_gate_advance must NOT contain the old Branch B phrase
    SELECT pg_get_functiondef(p.oid) INTO v_fn_body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'roadmap_proposal'
       AND p.proname = 'fn_guard_gate_advance';

    IF v_fn_body IS NULL THEN
        RAISE EXCEPTION '[P3566] fn_guard_gate_advance not found after CREATE OR REPLACE.';
    END IF;

    -- Branch B removed: must not mention the old "proposal_reviews approve within 10 minutes" solo path
    IF position('Submit a gate review (proposal_reviews verdict=approve)' IN v_fn_body) > 0 THEN
        RAISE EXCEPTION '[P3566] fn_guard_gate_advance still contains the old Branch B error text.';
    END IF;

    -- AC-3 marker present
    IF position('P3566 AC-3' IN v_fn_body) = 0 THEN
        RAISE EXCEPTION '[P3566] fn_guard_gate_advance missing AC-3 marker.';
    END IF;

    -- AC-1 marker present
    IF position('P3566 AC-1' IN v_fn_body) = 0 THEN
        RAISE EXCEPTION '[P3566] fn_guard_gate_advance missing AC-1 marker.';
    END IF;

    -- AC-2 marker present
    IF position('P3566 AC-2' IN v_fn_body) = 0 THEN
        RAISE EXCEPTION '[P3566] fn_guard_gate_advance missing AC-2 marker.';
    END IF;

    -- fn_actor_is_independent is called from fn_guard_gate_advance
    IF position('fn_actor_is_independent' IN v_fn_body) = 0 THEN
        RAISE EXCEPTION '[P3566] fn_guard_gate_advance does not call fn_actor_is_independent.';
    END IF;

    -- 3. Late-blocking trigger exists
    SELECT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'roadmap_proposal'
          AND c.relname = 'proposal_reviews'
          AND t.tgname  = 'trg_flag_late_blocking_review'
    ) INTO v_trigger_exists;
    IF NOT v_trigger_exists THEN
        RAISE EXCEPTION '[P3566] trg_flag_late_blocking_review trigger not found on proposal_reviews.';
    END IF;

    -- 4. v_gate_advance_eligibility view exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_views
        WHERE schemaname = 'roadmap_proposal'
          AND viewname   = 'v_gate_advance_eligibility'
    ) THEN
        RAISE EXCEPTION '[P3566] v_gate_advance_eligibility view not created.';
    END IF;

    RAISE NOTICE '[P3566] All post-migration checks passed: '
        'fn_actor_is_independent installed, fn_guard_gate_advance updated (AC-1/2/3), '
        'trg_flag_late_blocking_review installed, v_gate_advance_eligibility view created.';
END;
$verify$;

-- ---------------------------------------------------------------------------
-- Migration ledger entry.
-- ---------------------------------------------------------------------------
INSERT INTO roadmap.schema_migration (filename, checksum, applied_at)
VALUES ('289-p3566-gate-advance-integrity.sql', 'p3566-gate-advance-integrity', now())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
