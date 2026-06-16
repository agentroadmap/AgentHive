-- ============================================================================
-- Migration 290 — P1391: Verdict semantics v3 + gate-decision authority
-- ----------------------------------------------------------------------------
-- Builds the VERDICT + AUTHORITY layer on top of the structural lease slice
-- (migration 287) and the monotonic-maturity release trigger (migration 288).
--
-- This migration is SCHEMA-additive and is the DB half of the P1391 slice. The
-- destructive behavior it enables is gated end-to-end by the TS flag
-- AGENTHIVE_GATE_AUTHORITY_ENABLED (default OFF): nothing here changes existing
-- behavior on its own. With the flag OFF, no NEW write uses 'request_for_change'
-- / 'reject' / 'proposal_rejected' / the new dependency edges, so these widened
-- constraints simply lie dormant. Idempotent; NO inner BEGIN/COMMIT.
--
-- DO NOT apply to the live DB as part of this slice (operator sign-off required;
-- high blast radius — touches the live release trigger). Lint with:
--   psql -1 -f scripts/migrations/290-p1391-verdict-authority.sql  (on a txn you ROLLBACK)
-- ============================================================================

-- ── 1. release_reason enum: add 'proposal_rejected' (abandoned bucket). ──────
-- The reject verdict / obsolete close releases the lease with this reason; the
-- trigger CASE (below) maps it to maturity='obsolete'. Mirrors the TS canonical
-- source src/core/proposal/release-reasons.ts.
ALTER TABLE roadmap_proposal.proposal_lease
  DROP CONSTRAINT IF EXISTS proposal_lease_release_reason_enum_check;
ALTER TABLE roadmap_proposal.proposal_lease
  ADD CONSTRAINT proposal_lease_release_reason_enum_check
  CHECK (
    release_reason IS NULL OR release_reason = ANY (ARRAY[
      'work_delivered','gate_review_complete','authored_complete',
      'wont_pursue','superseded','out_of_scope','proposal_rejected',
      'gate_hold','gate_reject','lease_expired','manual_release',
      'released_unfinished','reassigned','force_reclaimed',
      'operator_cancelled','operator_terminated','gate_dispatch_blocked',
      'gate_spawn_failed','work_failed','gate_transitioned'
    ])
  );

-- ── 2. gate_decision_log.decision CHECK: add 'request_for_change'. ───────────
-- Historical rows are GRANDFATHERED: the legacy verdicts (hold/waive/escalate/
-- wontfix/discard/replace/nonissue) remain valid so old rows keep their CHECK.
-- The TS layer (recordGateDecision) is what restricts NEW writes to the
-- three-verdict vocab when the flag is ON; the DB stays permissive (superset).
ALTER TABLE roadmap_proposal.gate_decision_log
  DROP CONSTRAINT IF EXISTS gate_decision_log_decision_check;
ALTER TABLE roadmap_proposal.gate_decision_log
  ADD CONSTRAINT gate_decision_log_decision_check
  CHECK (decision = ANY (ARRAY[
    -- P1391 three-verdict canonical vocab
    'advance','request_for_change','reject',
    -- legacy verdicts (grandfathered; historical rows)
    'hold','waive','escalate','wontfix','discard','replace','nonissue'
  ]));

-- Optional, safe one-time legacy rename (commented; flip on with operator OK):
--   UPDATE roadmap_proposal.gate_decision_log
--      SET decision = 'request_for_change' WHERE decision = 'hold';

-- ── 3. proposal_dependencies type vocab: add reject-reference edges. ─────────
-- 'superseded_by' (the replacing proposal) and 'conflicts_with' (the
-- conflicting architecture proposal) are the structured justification an agent
-- reject requires (P1391 A9).
ALTER TABLE roadmap_proposal.proposal_dependencies
  DROP CONSTRAINT IF EXISTS proposal_deps_type_check;
ALTER TABLE roadmap_proposal.proposal_dependencies
  ADD CONSTRAINT proposal_deps_type_check
  CHECK (dependency_type = ANY (ARRAY[
    'blocks','depended_by','supersedes','relates','derived_from',
    'superseded_by','conflicts_with'  -- P1391 reject-reference edges
  ]));

-- ── 4. authority_grant scope_category: document the P1391 scopes. ────────────
-- scope_category is free text (no CHECK). The P1391 elevated paths read
-- scope_category IN ('gate_reject','proposal_obsolete'). No DDL needed; this
-- comment is the contract. A grant-issuance helper is provided in TS/CLI.
COMMENT ON COLUMN roadmap.authority_grant.scope_category IS
  'Free-text scope. P1391 reads gate_reject / proposal_obsolete to authorize a delegated reject/obsolete close.';

-- ── 5. release-trigger CASE: map 'proposal_rejected' → obsolete (all branches).
-- CREATE OR REPLACE of the live fn_lease_clear_maturity_on_release with the
-- 'proposal_rejected' WHEN added to the abandoned bucket in each maturity branch.
-- Every other mapping is preserved verbatim from migration 288 (P3535).

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_lease_clear_maturity_on_release()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_other_alive_count int;
  v_status            text;
  v_type              text;
  v_is_terminal       boolean;
  v_old_maturity      text;
  v_new_maturity      text;
  v_audit_entry       jsonb;
BEGIN
  -- Only fire on the released_at NULL → NOT NULL transition.
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip if another agent still holds the proposal.
  SELECT count(*) INTO v_other_alive_count
    FROM roadmap_proposal.proposal_lease
   WHERE proposal_id = NEW.proposal_id
     AND id <> NEW.id
     AND released_at IS NULL
     AND (expires_at IS NULL OR expires_at > now());
  IF v_other_alive_count > 0 THEN RETURN NEW; END IF;

  SELECT status, type, maturity
    INTO v_status, v_type, v_old_maturity
    FROM roadmap_proposal.proposal
   WHERE id = NEW.proposal_id;

  -- Obsolete is a terminal closure; never overwrite (P706 contract).
  IF v_old_maturity = 'obsolete' THEN
    RETURN NEW;
  END IF;

  -- Terminal-stage check: proposals at the workflow's last stage settle to
  -- mature regardless of release_reason (independent of maturity branch).
  SELECT EXISTS (
    SELECT 1
      FROM roadmap.proposal_type_config ptc
      JOIN roadmap.workflow_templates wt ON wt.name = ptc.workflow_name
      JOIN roadmap.workflow_stages ws ON ws.template_id = wt.id
     WHERE ptc.type = LOWER(v_type)
       AND UPPER(ws.stage_name) = UPPER(v_status)
       AND ws.stage_order = (
           SELECT MAX(stage_order) FROM roadmap.workflow_stages
            WHERE template_id = wt.id
       )
  ) INTO v_is_terminal;

  IF v_is_terminal THEN
    v_new_maturity := 'mature';

  ELSIF v_old_maturity = 'mature' THEN
    -- P3535: mature is sticky. Only the send-back bucket demotes to 'new'.
    v_new_maturity := CASE NEW.release_reason
      -- abandoned bucket → obsolete
      WHEN 'wont_pursue'           THEN 'obsolete'
      WHEN 'superseded'            THEN 'obsolete'
      WHEN 'out_of_scope'          THEN 'obsolete'
      WHEN 'proposal_rejected'    THEN 'obsolete'  -- P1391: reject verdict / obsolete close

      -- send-back bucket → new (the only demotion path from mature)
      WHEN 'gate_hold'             THEN 'new'
      WHEN 'gate_reject'           THEN 'new'
      WHEN 'work_failed'           THEN 'new'
      WHEN 'manual_release'        THEN 'new'
      WHEN 'reassigned'            THEN 'new'
      WHEN 'force_reclaimed'       THEN 'new'

      -- work_complete bucket → preserve mature (already there)
      WHEN 'work_delivered'        THEN 'mature'
      WHEN 'gate_review_complete'  THEN 'mature'
      WHEN 'authored_complete'     THEN 'mature'

      -- incomplete/passive → preserve mature (temporary release; still ready)
      WHEN 'lease_expired'         THEN 'mature'
      WHEN 'released_unfinished'   THEN 'mature'
      WHEN 'operator_cancelled'    THEN 'mature'
      WHEN 'operator_terminated'   THEN 'mature'
      WHEN 'gate_dispatch_blocked' THEN 'mature'
      WHEN 'gate_spawn_failed'     THEN 'mature'

      -- internal: stage transition auto-release
      WHEN 'gate_transitioned'     THEN 'mature'

      ELSE NULL
    END;

    IF v_new_maturity IS NULL THEN
      RAISE EXCEPTION
        '[P3535/P934] Unknown release_reason %L on proposal_lease %; aborting. '
        'Canonical reasons: see src/core/proposal/release-reasons.ts. '
        'No silent demotion.',
        NEW.release_reason, NEW.id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

  ELSIF v_old_maturity = 'active' THEN
    -- P3535 AC-2: 'active' is a sticky work-started marker. A release, lease
    -- expiry, or re-claim must NEVER revert it to 'new'. Only work-complete
    -- advances it (→mature) and abandonment closes it (→obsolete); every other
    -- reason preserves 'active'. Unknown reasons RAISE (no silent demotion).
    v_new_maturity := CASE NEW.release_reason
      -- work_complete bucket → mature
      WHEN 'work_delivered'        THEN 'mature'
      WHEN 'gate_review_complete'  THEN 'mature'
      WHEN 'authored_complete'     THEN 'mature'

      -- abandoned bucket → obsolete
      WHEN 'wont_pursue'           THEN 'obsolete'
      WHEN 'superseded'            THEN 'obsolete'
      WHEN 'out_of_scope'          THEN 'obsolete'
      WHEN 'proposal_rejected'    THEN 'obsolete'  -- P1391: reject verdict / obsolete close

      -- send-back bucket → preserve active (work has started; back to queue
      -- as a still-active proposal, never demoted to 'new')
      WHEN 'gate_hold'             THEN 'active'
      WHEN 'gate_reject'           THEN 'active'
      WHEN 'work_failed'           THEN 'active'
      WHEN 'manual_release'        THEN 'active'
      WHEN 'reassigned'            THEN 'active'
      WHEN 'force_reclaimed'       THEN 'active'

      -- incomplete/passive → preserve active
      WHEN 'lease_expired'         THEN 'active'
      WHEN 'released_unfinished'   THEN 'active'
      WHEN 'operator_cancelled'    THEN 'active'
      WHEN 'operator_terminated'   THEN 'active'
      WHEN 'gate_dispatch_blocked' THEN 'active'
      WHEN 'gate_spawn_failed'     THEN 'active'

      -- internal: stage transition auto-release → preserve active
      WHEN 'gate_transitioned'     THEN 'active'

      ELSE NULL
    END;

    IF v_new_maturity IS NULL THEN
      RAISE EXCEPTION
        '[P3535/P934] Unknown release_reason %L on proposal_lease %; aborting. '
        'Canonical reasons: see src/core/proposal/release-reasons.ts. '
        'No silent demotion.',
        NEW.release_reason, NEW.id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

  ELSE
    -- Genuinely 'new' proposals (released before ever advancing to active).
    -- Full P934 CASE preserved; unknown reasons RAISE.
    v_new_maturity := CASE NEW.release_reason
      -- work_complete bucket → mature
      WHEN 'work_delivered'        THEN 'mature'
      WHEN 'gate_review_complete'  THEN 'mature'
      WHEN 'authored_complete'     THEN 'mature'

      -- abandoned bucket → obsolete
      WHEN 'wont_pursue'           THEN 'obsolete'
      WHEN 'superseded'            THEN 'obsolete'
      WHEN 'out_of_scope'          THEN 'obsolete'
      WHEN 'proposal_rejected'    THEN 'obsolete'  -- P1391: reject verdict / obsolete close

      -- incomplete bucket → new (proposal returns to queue)
      WHEN 'gate_hold'             THEN 'new'
      WHEN 'gate_reject'           THEN 'new'
      WHEN 'lease_expired'         THEN 'new'
      WHEN 'manual_release'        THEN 'new'
      WHEN 'released_unfinished'   THEN 'new'
      WHEN 'reassigned'            THEN 'new'
      WHEN 'force_reclaimed'       THEN 'new'
      WHEN 'operator_cancelled'    THEN 'new'
      WHEN 'operator_terminated'   THEN 'new'
      WHEN 'gate_dispatch_blocked' THEN 'new'
      WHEN 'gate_spawn_failed'     THEN 'new'
      WHEN 'work_failed'           THEN 'new'

      -- internal (trigger-only) → new for the next stage
      WHEN 'gate_transitioned'     THEN 'new'

      ELSE NULL
    END;

    IF v_new_maturity IS NULL THEN
      RAISE EXCEPTION
        '[P934] Unknown release_reason %L on proposal_lease %; aborting. '
        'Canonical reasons: see src/core/proposal/release-reasons.ts. '
        'No silent demotion.',
        NEW.release_reason, NEW.id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- Apply the maturity change.
  UPDATE roadmap_proposal.proposal
     SET maturity = v_new_maturity
   WHERE id = NEW.proposal_id
     AND maturity <> 'obsolete';  -- belt-and-suspenders against concurrent obsolete

  -- P934 AC-6 / P3535 AC-5: audit-event write.
  IF v_old_maturity IS DISTINCT FROM v_new_maturity THEN
    v_audit_entry := jsonb_build_object(
      'TS',             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'Activity',       'MaturityChange',
      'From',           v_old_maturity,
      'To',             v_new_maturity,
      'Agent',          'lease_release_trigger',
      'release_reason', NEW.release_reason,
      'lease_id',       NEW.id
    );
    UPDATE roadmap_proposal.proposal
       SET audit = COALESCE(audit, '[]'::jsonb) || jsonb_build_array(v_audit_entry)
     WHERE id = NEW.proposal_id;
  END IF;

  RETURN NEW;
END;
$function$


-- NOTE: the trigger binding (trg on proposal_lease) already exists from prior
-- migrations; CREATE OR REPLACE FUNCTION re-points it in place. No re-bind here.
