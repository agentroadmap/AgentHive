-- env: prod
-- P3535 — Decouple maturity lifecycle from lease occupancy.
--
-- Problem: maturity='active' is set on ANY claim (fn_lease_set_maturity_active
-- flips active for any maturity value), so a mature proposal reviewed by a gate
-- agent regresses to 'active'. Maturity is overloaded as both lifecycle-state
-- AND lease-occupancy indicator, creating dispatch flap and state confusion.
--
-- Fix: make maturity MONOTONIC with respect to work progress:
--   new → active  : ONLY on the first claim of a 'new' proposal
--   active        : sticky — subsequent claims, releases, or lease expiry do NOT demote it
--   mature        : sticky across gate claims; only a send-back release reason resets it to 'new'
--   mature → new  : ONLY via send-back bucket (gate_hold/gate_reject/work_failed/
--                   manual_release/reassigned/force_reclaimed)
--   obsolete      : unchanged — sink state, reachable from any state
--
-- DEPENDS ON:
--   P1391 (AC-7): lease_is_live(), fn_check_lease_available, proposal_lease_no_overlap_live
--   128-p934-lease-release-deterministic-mapping.sql: trigger this migration extends
--   129-p934-release-reason-backfill-and-check.sql: work_failed branch + CHECK constraint
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION for both trigger rewrites.
-- Records in roadmap.schema_migration.

BEGIN;

-- ─── 0. Preflight: assert P1391 objects exist ────────────────────────────────
DO $preflight$
DECLARE
  v_missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'lease_is_live'
       AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap_proposal')
  ) THEN
    v_missing := v_missing || ' lease_is_live';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_check_lease_available'
       AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
  ) THEN
    v_missing := v_missing || ' fn_check_lease_available';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'proposal_lease_no_overlap_live'
  ) THEN
    v_missing := v_missing || ' proposal_lease_no_overlap_live';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION '[P3535] preflight failed — P1391 objects missing:%', v_missing;
  END IF;

  RAISE NOTICE '[P3535] preflight OK: P1391 objects confirmed present';
END;
$preflight$;

-- ─── 1. Rewrite fn_lease_set_maturity_active ────────────────────────────────
-- P3535 AC-1 / AC-5: claiming a proposal ONLY sets maturity='active' when
-- current maturity='new' (the new→active edge). Claiming a mature proposal
-- for gate review leaves it 'mature'; claiming an already-active proposal
-- leaves it 'active'. The old guard `AND maturity <> 'obsolete'` permitted
-- retrograde active transitions from any maturity.
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_lease_set_maturity_active()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.released_at IS NULL THEN
    PERFORM set_config('app.agent_identity', NEW.agent_identity, true);

    -- P3535: monotonic new→active only. Mature/active/obsolete are untouched.
    UPDATE roadmap_proposal.proposal
       SET maturity = 'active'
     WHERE id = NEW.proposal_id
       AND maturity = 'new';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 2. Rewrite fn_lease_clear_maturity_on_release ──────────────────────────
-- P3535 AC-2 / AC-6: add monotonic guards AFTER the P934 CASE mapping:
--   • 'active' is sticky: if the computed outcome is 'new', keep 'active'.
--     (AC-2: subsequent release, lease expiry, or re-claim must not revert it)
--   • 'mature' → 'new' ONLY via send-back bucket:
--       gate_hold, gate_reject, work_failed, manual_release, reassigned, force_reclaimed
--     Non-send-back incomplete reasons (lease_expired, released_unfinished,
--     operator_cancelled, operator_terminated, gate_dispatch_blocked,
--     gate_spawn_failed, gate_transitioned) preserve 'mature'.
--
-- The full P934 CASE map and its unknown-reason RAISE are PRESERVED exactly
-- (migration 129 shape). Only a post-CASE guard is added (AC-6 requirement).
-- Touches NO lease constraint and NO is_active column (owned by P1391).
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

  -- Skip if another agent still holds the proposal (P934: alive-lease check).
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
    -- Keep this CASE in sync with src/core/proposal/release-reasons.ts.
    v_new_maturity := CASE NEW.release_reason
      -- work_complete bucket → mature
      WHEN 'work_delivered'        THEN 'mature'
      WHEN 'gate_review_complete'  THEN 'mature'
      WHEN 'authored_complete'     THEN 'mature'

      -- abandoned bucket → obsolete
      WHEN 'wont_pursue'           THEN 'obsolete'
      WHEN 'superseded'            THEN 'obsolete'
      WHEN 'out_of_scope'          THEN 'obsolete'

      -- incomplete bucket → new (subject to P3535 monotonic guards below)
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

      -- Unknown / NULL: loud failure (P934 AC-4). Aborts the release transaction.
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

    -- ── P3535 monotonic guards ───────────────────────────────────────────────
    -- Applied AFTER the P934 CASE so all unknown-reason errors still fire.
    IF v_new_maturity = 'new' THEN
      -- AC-2: 'active' is sticky — never demote to 'new' via any lease event.
      IF v_old_maturity = 'active' THEN
        v_new_maturity := 'active';

      -- AC-6: 'mature' → 'new' ONLY via send-back bucket.
      -- Non-send-back incomplete reasons (lease_expired, released_unfinished,
      -- operator_cancelled, operator_terminated, gate_dispatch_blocked,
      -- gate_spawn_failed, gate_transitioned) preserve 'mature'.
      ELSIF v_old_maturity = 'mature'
        AND NEW.release_reason NOT IN (
          'gate_hold', 'gate_reject', 'work_failed',
          'manual_release', 'reassigned', 'force_reclaimed'
        )
      THEN
        v_new_maturity := 'mature';
      END IF;
    END IF;
    -- ── end P3535 guards ─────────────────────────────────────────────────────
  END IF;

  -- Apply the maturity change.
  UPDATE roadmap_proposal.proposal
     SET maturity = v_new_maturity
   WHERE id = NEW.proposal_id
     AND maturity <> 'obsolete';

  -- P934 AC-6 — audit-event write. Append to proposal.audit JSONB.
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

-- ─── 3. Reconcile in-flight proposals (AC-9) ────────────────────────────────
-- Restore proposals whose maturity='active' but should be 'mature' under the
-- new monotonic rules:
--   a) Terminal-status (COMPLETE/MERGED/DEPLOYED/CLOSED) with no alive lease
--      → 'mature' (these are stuck from gate-claim-on-completed-work pattern)
--   b) Non-terminal proposals with no alive lease whose last released lease
--      had a work_complete reason → 'mature' (gate review already signed off)
-- Proposals with a live gate-role dispatch but no alive lease are also captured
-- by (b). Proposals with an ALIVE lease are left untouched (in-flight).
-- Guard: maturity<>'obsolete' preserved throughout.

WITH reconcile_targets AS (
  SELECT p.id,
         p.maturity          AS old_maturity,
         p.status,
         p.type,
         -- last released lease reason
         (SELECT l.release_reason
            FROM roadmap_proposal.proposal_lease l
           WHERE l.proposal_id = p.id
             AND l.released_at IS NOT NULL
           ORDER BY l.released_at DESC
           LIMIT 1) AS last_reason
    FROM roadmap_proposal.proposal p
   WHERE p.maturity = 'active'
     AND p.maturity <> 'obsolete'
     -- no alive lease
     AND NOT EXISTS (
       SELECT 1 FROM roadmap_proposal.proposal_lease al
        WHERE al.proposal_id = p.id
          AND al.released_at IS NULL
          AND (al.expires_at IS NULL OR al.expires_at > now())
     )
)
UPDATE roadmap_proposal.proposal p
   SET maturity = 'mature',
       audit    = COALESCE(p.audit, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
         'TS',        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'Activity',  'MaturityChange',
         'From',      'active',
         'To',        'mature',
         'Agent',     'p3535_reconcile',
         'reason',    CASE
                        WHEN rt.status IN ('COMPLETE','DEPLOYED','CLOSED','MERGED','RECYCLED') THEN 'terminal_status'
                        ELSE 'last_reason_work_complete'
                      END
       ))
  FROM reconcile_targets rt
 WHERE p.id = rt.id
   AND (
     -- terminal status: should always be mature
     rt.status IN ('COMPLETE','DEPLOYED','CLOSED','MERGED','RECYCLED')
     OR
     -- last release was work_complete → was mature before gate claimed it
     rt.last_reason IN ('work_delivered', 'gate_review_complete', 'authored_complete')
   );

-- ─── 4. Verify trigger bindings are intact ──────────────────────────────────
DO $verify$
DECLARE
  v_set_action   text;
  v_clear_action text;
BEGIN
  SELECT action_statement INTO v_set_action
    FROM information_schema.triggers
   WHERE event_object_schema = 'roadmap_proposal'
     AND event_object_table  = 'proposal_lease'
     AND trigger_name        = 'trg_lease_set_maturity_active'
   LIMIT 1;

  IF v_set_action IS NULL THEN
    RAISE EXCEPTION '[P3535] trg_lease_set_maturity_active trigger not found on proposal_lease';
  END IF;
  IF v_set_action NOT LIKE '%fn_lease_set_maturity_active%' THEN
    RAISE EXCEPTION '[P3535] trg_lease_set_maturity_active does not call fn_lease_set_maturity_active; got %', v_set_action;
  END IF;

  SELECT action_statement INTO v_clear_action
    FROM information_schema.triggers
   WHERE event_object_schema = 'roadmap_proposal'
     AND event_object_table  = 'proposal_lease'
     AND trigger_name        = 'trg_lease_clear_maturity_on_release'
   LIMIT 1;

  IF v_clear_action IS NULL THEN
    RAISE EXCEPTION '[P3535] trg_lease_clear_maturity_on_release trigger not found on proposal_lease';
  END IF;
  IF v_clear_action NOT LIKE '%fn_lease_clear_maturity_on_release%' THEN
    RAISE EXCEPTION '[P3535] trg_lease_clear_maturity_on_release does not call fn_lease_clear_maturity_on_release; got %', v_clear_action;
  END IF;

  RAISE NOTICE '[P3535] trigger bindings verified';
END;
$verify$;

-- ─── 5. Register migration ───────────────────────────────────────────────────
INSERT INTO roadmap.schema_migration (filename, checksum, applied_by)
VALUES ('283-p3535-monotonic-maturity-lifecycle.sql', 'b191868ce3544507cc2dbae72c2e80dd', 'p3535')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
