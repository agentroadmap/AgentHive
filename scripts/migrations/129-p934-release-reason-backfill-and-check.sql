-- env: prod
-- P934 Phase 5 — Backfill remaining legacy release_reason values to canonical
-- taxonomy + add CHECK constraints (enum + length cap).
--
-- DEPENDS ON: 128-p934-lease-release-deterministic-mapping.sql (the trigger
-- that this migration extends with a 'work_failed' branch).
-- ROLLBACK: 129-p934-release-reason-backfill-and-check.rollback.sql
--
-- Three steps:
--   1. Add 'work_failed' to the trigger's CASE (semantically distinct from
--      released_unfinished; observed 2,534 times in legacy data).
--   2. Backfill every legacy release_reason value to its canonical equivalent
--      (idempotent — re-runs are no-ops because the WHERE filters by legacy
--      values that no longer exist after the first pass).
--   3. Add CHECK constraints:
--      a. release_reason must be in CALLER_RELEASE_REASONS ∪ {gate_transitioned}
--         (the same enum the TS taxonomy enforces)
--      b. length(release_reason) <= 128 (P934 AC-13 — prevents stderr-as-reason
--         class of bug; longest canonical value is 'gate_dispatch_blocked' at 21
--         chars)
--
-- The CHECK on enum is added with NOT VALID and then VALIDATE in a separate
-- statement so a bad row reveals itself as a clear validation error rather
-- than blocking the migration on a single straggler. NOT VALID + VALIDATE
-- also avoids holding ACCESS EXCLUSIVE long.
--
-- Idempotent: ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS pattern via DO
-- block; UPDATE statements filter by legacy values.

BEGIN;

-- ── Step 1: extend trigger CASE with 'work_failed' ──────────────────
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
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;

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

  IF v_old_maturity = 'obsolete' THEN
    RETURN NEW;
  END IF;

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
    v_new_maturity := CASE NEW.release_reason
      WHEN 'work_delivered'        THEN 'mature'
      WHEN 'gate_review_complete'  THEN 'mature'
      WHEN 'authored_complete'     THEN 'mature'
      WHEN 'wont_pursue'           THEN 'obsolete'
      WHEN 'superseded'            THEN 'obsolete'
      WHEN 'out_of_scope'          THEN 'obsolete'
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
      WHEN 'work_failed'           THEN 'new'   -- P934 phase 5: NEW
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

  UPDATE roadmap_proposal.proposal
     SET maturity = v_new_maturity
   WHERE id = NEW.proposal_id
     AND maturity <> 'obsolete';

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

-- ── Step 2: backfill legacy values ──────────────────────────────────
-- Bucket-rewrite legacy variants to canonical equivalents. Every UPDATE
-- below is idempotent (re-runs hit zero matching rows after the first pass).
-- Order matters only for the catch-all at the end.

-- Hyphen variants → underscore
UPDATE roadmap_proposal.proposal_lease SET release_reason = 'force_reclaimed'
 WHERE release_reason = 'force-reclaimed';

-- Reaper / expiry variants
UPDATE roadmap_proposal.proposal_lease SET release_reason = 'lease_expired'
 WHERE release_reason IN ('expired', 'reaped_offer_expired', 'reaped_offer_exhausted',
                          'auto-released: stale lease (P224 AC-6)',
                          'auto-reap: proposal already COMPLETE',
                          'auto-reap: proposal terminal');

-- Stale "[reaped: ...]" stragglers (the corruption pattern Phase 0 didn't catch
-- because they begin with a leading space rather than the prefix patterns).
UPDATE roadmap_proposal.proposal_lease SET release_reason = 'lease_expired'
 WHERE release_reason LIKE '%[reaped%';

UPDATE roadmap_proposal.proposal_lease SET release_reason = 'force_reclaimed'
 WHERE release_reason = 'force-released: admin cleanup (P224 AC-6)';

-- Gate-decision variants → canonical
UPDATE roadmap_proposal.proposal_lease SET release_reason = 'gate_review_complete'
 WHERE release_reason IN ('gate_decision_complete', 'gate_complete');

UPDATE roadmap_proposal.proposal_lease SET release_reason = 'gate_hold'
 WHERE release_reason IN ('gate_decision_hold',
                          'gate_decision_send_back',
                          'gate decision completed without state transition: proposal is DRAFT/new',
                          'gate decision completed without state transition: proposal is DEVELOP/new');

-- Gate-spawn / dispatch failure variants
UPDATE roadmap_proposal.proposal_lease SET release_reason = 'gate_spawn_failed'
 WHERE release_reason LIKE 'gate spawn failed:%';

UPDATE roadmap_proposal.proposal_lease SET release_reason = 'gate_dispatch_blocked'
 WHERE release_reason LIKE 'gate dispatch blocked:%';

-- Legacy default
UPDATE roadmap_proposal.proposal_lease SET release_reason = 'manual_release'
 WHERE release_reason = 'released';

-- Cubic-stale variants
UPDATE roadmap_proposal.proposal_lease SET release_reason = 'lease_expired'
 WHERE release_reason LIKE 'cubic_stale_timeout:%';

-- ── Step 3: any remaining non-canonical NULLs / unknowns ────────────
-- After all bucketed UPDATEs, any leftover non-canonical value is
-- mapped to 'manual_release' (incomplete bucket, conservative — sends
-- the proposal back to the queue rather than locking it as complete).
-- This preserves AC-9's "best-effort backfill" stance documented in P934.
UPDATE roadmap_proposal.proposal_lease
   SET release_reason = 'manual_release'
 WHERE release_reason IS NOT NULL
   AND release_reason NOT IN (
     'work_delivered','gate_review_complete','authored_complete',
     'wont_pursue','superseded','out_of_scope',
     'gate_hold','gate_reject','lease_expired','manual_release',
     'released_unfinished','reassigned','force_reclaimed',
     'operator_cancelled','operator_terminated',
     'gate_dispatch_blocked','gate_spawn_failed','work_failed',
     'gate_transitioned'
   );

-- ── Step 4: pre-flight verification ─────────────────────────────────
DO $verify$
DECLARE
  v_oversized int;
  v_unknown int;
BEGIN
  SELECT count(*) INTO v_oversized FROM roadmap_proposal.proposal_lease
   WHERE release_reason IS NOT NULL AND length(release_reason) > 128;
  IF v_oversized > 0 THEN
    RAISE EXCEPTION '[P934] backfill incomplete: % rows still > 128 chars', v_oversized;
  END IF;

  SELECT count(*) INTO v_unknown FROM roadmap_proposal.proposal_lease
   WHERE release_reason IS NOT NULL
     AND release_reason NOT IN (
       'work_delivered','gate_review_complete','authored_complete',
       'wont_pursue','superseded','out_of_scope',
       'gate_hold','gate_reject','lease_expired','manual_release',
       'released_unfinished','reassigned','force_reclaimed',
       'operator_cancelled','operator_terminated',
       'gate_dispatch_blocked','gate_spawn_failed','work_failed',
       'gate_transitioned'
     );
  IF v_unknown > 0 THEN
    RAISE EXCEPTION '[P934] backfill incomplete: % rows still have non-canonical reasons', v_unknown;
  END IF;
  RAISE NOTICE '[P934] backfill verified: 0 oversized, 0 non-canonical';
END;
$verify$;

-- ── Step 5: add CHECK constraints (NOT VALID, then VALIDATE) ────────
-- enum CHECK
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'proposal_lease_release_reason_enum_check'
       AND conrelid = 'roadmap_proposal.proposal_lease'::regclass
  ) THEN
    ALTER TABLE roadmap_proposal.proposal_lease
      ADD CONSTRAINT proposal_lease_release_reason_enum_check
      CHECK (
        release_reason IS NULL OR release_reason IN (
          'work_delivered','gate_review_complete','authored_complete',
          'wont_pursue','superseded','out_of_scope',
          'gate_hold','gate_reject','lease_expired','manual_release',
          'released_unfinished','reassigned','force_reclaimed',
          'operator_cancelled','operator_terminated',
          'gate_dispatch_blocked','gate_spawn_failed','work_failed',
          'gate_transitioned'
        )
      ) NOT VALID;
    ALTER TABLE roadmap_proposal.proposal_lease
      VALIDATE CONSTRAINT proposal_lease_release_reason_enum_check;
  END IF;
END;
$constraint$;

-- length CHECK (AC-13)
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'proposal_lease_release_reason_length_check'
       AND conrelid = 'roadmap_proposal.proposal_lease'::regclass
  ) THEN
    ALTER TABLE roadmap_proposal.proposal_lease
      ADD CONSTRAINT proposal_lease_release_reason_length_check
      CHECK (release_reason IS NULL OR length(release_reason) <= 128) NOT VALID;
    ALTER TABLE roadmap_proposal.proposal_lease
      VALIDATE CONSTRAINT proposal_lease_release_reason_length_check;
  END IF;
END;
$constraint$;

COMMIT;
