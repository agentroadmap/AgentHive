-- env: prod
-- P934 Phase 3 — Rewrite fn_lease_clear_maturity_on_release as a deterministic
-- CASE matching the canonical taxonomy in src/core/proposal/release-reasons.ts.
-- Removes the silent ELSE → 'new' fall-through that demoted P931 from
-- mature → new without an audit entry. Unknown reasons now RAISE
-- EXCEPTION, aborting the release transaction (loud failure beats silent
-- demotion — see P934 AC-4).
--
-- Also adds an audit-event write (P934 AC-6): every maturity mutation
-- caused by this trigger appends to roadmap_proposal.proposal.audit JSONB
-- with agent='lease_release_trigger', release_reason, lease_id,
-- from_maturity, to_maturity. Closes the audit gap that hid P931's
-- demotion from the operator at 2026-05-09 21:46:14 UTC.
--
-- DEPENDS ON: 067-p438-claim-policy-fail-closed.sql (creates the trigger
-- this rewrites), 070-p741-lease-release-and-notify-suppression.sql (the
-- gate_transitioned auto-release path that fires this trigger).
-- ROLLBACK: 128-p934-lease-release-deterministic-mapping.rollback.sql
--
-- Idempotent: CREATE OR REPLACE FUNCTION.
-- Runs in a single transaction; rolls back cleanly on any step failure.

BEGIN;

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

  -- Terminal-stage check: proposals at the workflow's last stage settle
  -- to mature unless obsolete. Independent of release_reason.
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
  ELSE
    -- P934 deterministic mapping. NO ELSE FALL-THROUGH.
    -- Keep this CASE in sync with src/core/proposal/release-reasons.ts
    -- RELEASE_REASONS_BY_OUTCOME + OUTCOME_TO_MATURITY.
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

      -- internal (trigger-only) → new for the next stage
      WHEN 'gate_transitioned'     THEN 'new'

      -- Unknown / NULL: loud failure. Aborts the release transaction.
      -- Caller must use a canonical reason from
      -- src/core/proposal/release-reasons.ts. This replaces the prior
      -- ELSE → 'new' fall-through that silently demoted on the P931
      -- incident 2026-05-09 21:46:14 UTC.
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

  -- P934 AC-6 — audit-event write. Append to proposal.audit JSONB so
  -- trigger-cascaded maturity changes are visible in the audit trail
  -- (the gap that hid P931's demotion). Mirrors the StatusChange entry
  -- shape used by fn_log_proposal_state_change.
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

-- Sanity: confirm trigger is bound to the function we just rewrote.
DO $verify$
DECLARE
  v_action text;
BEGIN
  SELECT action_statement INTO v_action
    FROM information_schema.triggers
   WHERE event_object_schema = 'roadmap_proposal'
     AND event_object_table = 'proposal_lease'
     AND trigger_name = 'trg_lease_clear_maturity_on_release'
   LIMIT 1;
  IF v_action IS NULL THEN
    RAISE EXCEPTION '[P934] trg_lease_clear_maturity_on_release trigger not found on proposal_lease';
  END IF;
  IF v_action NOT LIKE '%fn_lease_clear_maturity_on_release%' THEN
    RAISE EXCEPTION '[P934] trigger does not call fn_lease_clear_maturity_on_release; got %', v_action;
  END IF;
  RAISE NOTICE '[P934] trigger verified: %', v_action;
END;
$verify$;

COMMIT;
