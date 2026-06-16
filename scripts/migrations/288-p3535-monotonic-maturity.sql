-- 288-p3535-monotonic-maturity.sql
-- P3535: Decouple maturity lifecycle from lease occupancy — monotonic progress.
--
-- DESIGN: maturity is a work-readiness signal (new → active → mature), not a
-- lease-occupancy mirror. After this migration:
--   • A claim advances new → active only (active/mature are unchanged by claim).
--   • On release, mature is sticky UNLESS the reason is in the "send-back"
--     bucket (gate_hold, gate_reject, work_failed, manual_release, reassigned,
--     force_reclaimed). All other reasons preserve mature.
--   • This eliminates the handleGateCompletion race: release fires while
--     maturity=mature → trigger preserves mature → explicit set_maturity('new')
--     wins cleanly with no active lease.
--
-- ALSO ADDS: work_failed release_reason to fn_lease_clear_maturity_on_release
-- (present in src/core/proposal/release-reasons.ts since P934 but absent from
-- migration 128's CASE, causing RAISE if used on a non-terminal proposal).
--
-- DEPENDS ON: migration 287 (P1391 — lease_is_live(), EXCLUDE constraint).
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION.
-- Runs in a single transaction; no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- AC-7 PREFLIGHT: confirm P1391 structural objects are live.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_proposal'
      AND p.proname = 'lease_is_live'
  ) THEN
    RAISE EXCEPTION
      '[P3535] Preflight failed: roadmap_proposal.lease_is_live() not found. '
      'Migration 287 (P1391) must be applied first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roadmap_proposal.proposal_lease'::regclass
      AND conname  = 'proposal_lease_no_overlap_live'
  ) THEN
    RAISE EXCEPTION
      '[P3535] Preflight failed: constraint proposal_lease_no_overlap_live not '
      'found on roadmap_proposal.proposal_lease. Migration 287 (P1391) must be '
      'applied first.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- AC-2: fn_lease_set_maturity_active — ONLY new → active.
-- Old: AND maturity <> 'obsolete' (set active for ANY non-obsolete claim).
-- New: AND maturity = 'new'       (only the new→active edge; active and
--      mature are NOT clobbered by a new claim against an already-working prop).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_lease_set_maturity_active()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.released_at IS NULL THEN
    PERFORM set_config('app.agent_identity', NEW.agent_identity, true);

    UPDATE roadmap_proposal.proposal
       SET maturity = 'active'
     WHERE id = NEW.proposal_id
       AND maturity = 'new';  -- P3535: only new→active; active/mature unchanged
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- AC-3 + AC-4: fn_lease_clear_maturity_on_release — mature is sticky.
-- Extends P934 (migration 128) with a mature-sticky guard and adds the
-- missing work_failed reason to the CASE (it's in release-reasons.ts but
-- was absent from 128's CASE, which would RAISE on first use).
-- ---------------------------------------------------------------------------
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
    -- abandoned bucket → obsolete (regardless of maturity).
    -- send-back bucket → new (explicit gate/work rejection).
    -- all other known reasons → preserve 'mature'.
    -- unknown → RAISE (same loud-failure contract as P934).
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

      -- internal: stage transition auto-release; status-sync trigger already
      -- set maturity='new' for the new stage, but map consistently.
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

  ELSE
    -- For new/active proposals: full P934 CASE (unchanged) + work_failed added.
    -- NO ELSE FALL-THROUGH — unknown reasons RAISE.
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
      WHEN 'work_failed'           THEN 'new'   -- P3535: added (was missing from 128)

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

-- ---------------------------------------------------------------------------
-- AC-1 reconcile: restore proposals stuck at maturity='active' that should be
-- 'mature'. Two categories:
--   Cat-1: terminal status (COMPLETE/DEPLOYED/MERGED/CLOSED/RECYCLED).
--   Cat-2: no alive lease + last lease was a gate-role dispatch (gate agents
--          set a proposal active then released with gate_review_complete, but
--          the old trigger mapped that to 'mature' only for non-mature — some
--          props got left at active because claim-trigger ran on an already-
--          active prop and fn_sync_proposal_maturity set it active on advance).
-- Both categories write an audit entry for traceability.
-- ---------------------------------------------------------------------------

-- Cat-1: terminal status
UPDATE roadmap_proposal.proposal p
   SET maturity = 'mature',
       audit    = COALESCE(audit, '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                      'TS',       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                      'Activity', 'MaturityChange',
                      'From',     'active',
                      'To',       'mature',
                      'Agent',    'p3535-reconcile-terminal',
                      'Note',     'P3535 one-time reconcile: terminal-status proposal stuck at active'
                    )
                  )
 WHERE p.maturity = 'active'
   AND p.status IN ('COMPLETE','DEPLOYED','MERGED','CLOSED','RECYCLED');

-- Cat-2: no alive lease + last released lease had a work_complete reason
WITH gate_claimed AS (
  SELECT DISTINCT ON (l.proposal_id) l.proposal_id
    FROM roadmap_proposal.proposal_lease l
   WHERE l.released_at IS NOT NULL
   ORDER BY l.proposal_id, l.released_at DESC
),
last_release AS (
  SELECT DISTINCT ON (proposal_id)
    proposal_id, release_reason
  FROM roadmap_proposal.proposal_lease
  WHERE released_at IS NOT NULL
  ORDER BY proposal_id, released_at DESC
),
no_live_lease AS (
  SELECT p.id
    FROM roadmap_proposal.proposal p
   WHERE p.maturity = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM roadmap_proposal.proposal_lease l2
        WHERE l2.proposal_id = p.id
          AND l2.released_at IS NULL
          AND (l2.expires_at IS NULL OR l2.expires_at > now())
     )
)
UPDATE roadmap_proposal.proposal p
   SET maturity = 'mature',
       audit    = COALESCE(audit, '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object(
                      'TS',             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                      'Activity',       'MaturityChange',
                      'From',           'active',
                      'To',             'mature',
                      'Agent',          'p3535-reconcile-work-complete',
                      'release_reason', lr.release_reason,
                      'Note',           'P3535 one-time reconcile: no-live-lease prop stuck at active after work_complete release'
                    )
                  )
  FROM no_live_lease nl
  JOIN last_release lr ON lr.proposal_id = nl.id
 WHERE p.id = nl.id
   AND p.maturity = 'active'
   AND lr.release_reason IN ('work_delivered','gate_review_complete','authored_complete');

-- ---------------------------------------------------------------------------
-- AC-8: v_proposal_phase view — derives display phase from (maturity,
-- live dispatch_role). Shows 'mature (gating)' when a gate agent holds the
-- lease, 'active (building)' for build roles, raw maturity otherwise.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_phase AS
SELECT
  p.id            AS proposal_id,
  p.display_id,
  p.maturity,
  p.status,
  sd.dispatch_role AS live_dispatch_role,
  CASE
    WHEN sd.dispatch_role IN (
      'skeptic-beta','skeptic','reviewer-d1','qa',
      'gate-reviewer','gate_decision_agent','architect'
    ) THEN 'mature (gating)'
    WHEN sd.dispatch_role IN ('developer','engineer','builder')
      THEN 'active (building)'
    WHEN sd.dispatch_role IS NOT NULL
      THEN 'active (' || sd.dispatch_role || ')'
    ELSE p.maturity
  END AS phase
FROM roadmap_proposal.proposal p
LEFT JOIN LATERAL (
  SELECT sd2.dispatch_role
    FROM roadmap_workforce.squad_dispatch sd2
   WHERE sd2.proposal_id = p.id
     AND sd2.dispatch_status IN ('active','open','assigned')
     AND (sd2.claim_expires_at IS NULL OR sd2.claim_expires_at > now())
   ORDER BY sd2.assigned_at DESC
   LIMIT 1
) sd ON true;

-- ---------------------------------------------------------------------------
-- Post-migration verification.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_fn_body         text;
  v_active_stuck    int;
  v_view_exists     boolean;
BEGIN
  -- 1. fn_lease_set_maturity_active must contain the new→active guard
  SELECT pg_get_functiondef(p.oid) INTO v_fn_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'roadmap_proposal'
     AND p.proname = 'fn_lease_set_maturity_active';

  IF v_fn_body IS NULL THEN
    RAISE EXCEPTION '[P3535] fn_lease_set_maturity_active not found after CREATE OR REPLACE.';
  END IF;

  -- Check for the monotonic guard (maturity = 'new') — use position() to avoid
  -- dollar-quoting nesting issues with LIKE and embedded single quotes.
  IF position($$maturity = 'new'$$ IN v_fn_body) = 0 THEN
    RAISE EXCEPTION '[P3535] fn_lease_set_maturity_active does not contain the new→active monotonic guard.';
  END IF;

  -- 2. fn_lease_clear_maturity_on_release must contain mature-sticky guard
  SELECT pg_get_functiondef(p.oid) INTO v_fn_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'roadmap_proposal'
     AND p.proname = 'fn_lease_clear_maturity_on_release';

  IF v_fn_body IS NULL THEN
    RAISE EXCEPTION '[P3535] fn_lease_clear_maturity_on_release not found after CREATE OR REPLACE.';
  END IF;

  IF position('P3535' IN v_fn_body) = 0 THEN
    RAISE EXCEPTION '[P3535] fn_lease_clear_maturity_on_release does not contain P3535 guard comment.';
  END IF;

  -- 3. No proposals stuck at active with terminal status remain
  SELECT count(*) INTO v_active_stuck
    FROM roadmap_proposal.proposal
   WHERE maturity = 'active'
     AND status IN ('COMPLETE','DEPLOYED','MERGED','CLOSED','RECYCLED');
  IF v_active_stuck > 0 THEN
    RAISE EXCEPTION '[P3535] % terminal proposals still stuck at maturity=active after reconcile.', v_active_stuck;
  END IF;

  -- 4. v_proposal_phase view exists
  SELECT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'roadmap_proposal'
       AND viewname = 'v_proposal_phase'
  ) INTO v_view_exists;
  IF NOT v_view_exists THEN
    RAISE EXCEPTION '[P3535] v_proposal_phase view not created.';
  END IF;

  RAISE NOTICE '[P3535] All post-migration checks passed: monotonic maturity triggers live, reconcile complete, v_proposal_phase installed.';
END;
$verify$;

-- ---------------------------------------------------------------------------
-- Migration ledger entry.
-- ---------------------------------------------------------------------------
INSERT INTO roadmap.schema_migration (filename, checksum, applied_at)
VALUES ('288-p3535-monotonic-maturity.sql', 'p3535-monotonic-maturity', now())
ON CONFLICT (filename) DO NOTHING;
