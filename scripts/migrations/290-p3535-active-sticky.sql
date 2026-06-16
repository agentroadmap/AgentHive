-- 290-p3535-active-sticky.sql
-- P3535 AC-2 fix: 'active' is a sticky work-started marker.
--
-- BUG: migration 288 made 'mature' sticky but carried the P934 'ELSE' branch
-- verbatim for new/active proposals. That branch maps lease_expired/gate_hold/
-- manual_release/etc. → 'new', which DEMOTES an 'active' proposal back to 'new'
-- on release or lease expiry. This violates P3535 AC-2:
--
--   "The first claim of a 'new' proposal transitions it to 'active'; a
--    subsequent release, lease expiry, or re-claim leaves it 'active'
--    (never reverts to 'new')."
--
-- Observed failures (tests/p3535-monotonic-maturity.test.ts):
--   • AC-2 "lease_expired release does not revert active to new"  → got 'new'
--   • AC-2 "send-back release on active proposal keeps it active" → got 'new'
--
-- FIX: add an explicit 'active'-sticky branch to
-- roadmap_proposal.fn_lease_clear_maturity_on_release, mirroring the mature
-- branch. From 'active':
--   • work_complete bucket  (work_delivered/gate_review_complete/authored_complete) → 'mature'
--   • abandoned bucket      (wont_pursue/superseded/out_of_scope)                    → 'obsolete'
--   • everything else (send-back + incomplete/passive + gate_transitioned)          → preserve 'active'
--   • unknown reason → RAISE (loud-failure contract preserved, no silent demotion)
--
-- The 'new' branch (genuinely-new proposals never claimed) is UNCHANGED: a new
-- proposal that is released without ever advancing still maps per the P934 CASE.
-- Only the maturity-derivation trigger fn_lease_clear_maturity_on_release is
-- rewritten. NO lease constraint, NO is_active column, NO claim trigger touched
-- (P3535 AC-9 scope contract preserved). Idempotent: CREATE OR REPLACE.
--
-- ALSO (P3535 AC-10): drop the orphaned naive active→new flap function
-- roadmap.fn_lease_clear_maturity_on_release. It is NOT bound to any trigger
-- (the live trigger trg_lease_clear_maturity_on_release uses the
-- roadmap_proposal.* function), but migration 288 left the dead copy in place.
-- AC-10 requires it be dropped or documented as dead so a future trigger
-- rebind cannot resurrect the flap. Guarded DROP: only removes it if no
-- trigger references it. Idempotent (IF EXISTS).
--
-- DEPENDS ON: migration 288 (P3535) + 287 (P1391).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'fn_lease_clear_maturity_on_release'
      AND p.pronamespace = 'roadmap'::regnamespace
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      '[P3535 AC-10] roadmap.fn_lease_clear_maturity_on_release is bound to a '
      'live trigger — refusing to drop. Investigate before removing.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS roadmap.fn_lease_clear_maturity_on_release();

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
$function$;
