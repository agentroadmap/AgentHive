-- Migration 066 — P704 lease-maturity triggers
--
-- Problem (audit 2026-04-28):
--   95 proposals at maturity='active' have ZERO alive leases. Root cause:
--   1. fn_sync_proposal_maturity force-sets maturity='active' on status
--      transitions into DEVELOP/REVIEW/MERGE/FIX/ESCALATE — so "active" has
--      meant "mid-workflow," not "has alive claim."
--   2. proposal_lease release fires NO maturity update — gates can't see
--      ready-for-review proposals because they sit at maturity='active'.
--   3. P409 terminal guard skips maturity reset on COMPLETE — 23 rows are
--      double-stuck at status=COMPLETE/maturity=active.
--
-- Fix: redefine "active" as "has alive lease," enforced by triggers on
-- proposal_lease. Status sync still owns the obsolete/new mapping but
-- never touches active.
--
-- Idempotent: drops triggers/functions before recreating; safe to re-run.
--
-- NOTE: fn_sync_proposal_maturity MUST be created in the `roadmap` schema
-- because trg_proposal_maturity_sync is OID-bound to roadmap.fn_sync_proposal_maturity()
-- (confirmed: database/ddl/roadmap-baseline-2026-04-13.sql:5715).

BEGIN;

-- ─── 1. Rewrite fn_sync_proposal_maturity ───────────────────────────────
-- Remove the status→active mapping. Status no longer poisons maturity with
-- 'active'; only an alive lease can set that.
-- MUST use `roadmap` schema — the live trigger trg_proposal_maturity_sync
-- is OID-bound to roadmap.fn_sync_proposal_maturity().
CREATE OR REPLACE FUNCTION roadmap.fn_sync_proposal_maturity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Terminal-stage guard (P409): completed proposals should not have a
  -- live maturity. Force back to 'mature' so they stop appearing as
  -- "someone is working on this." Gates ignore COMPLETE rows anyway;
  -- this keeps the field honest.
  IF NEW.status IN ('DEPLOYED','COMPLETE','CLOSED','MERGED','RECYCLED') THEN
    NEW.maturity := 'mature';
    RETURN NEW;
  END IF;

  -- Obsolete sink stays as before.
  IF NEW.status IN ('REJECTED','DISCARDED','ABANDONED') THEN
    NEW.maturity := 'obsolete';
    RETURN NEW;
  END IF;

  -- Default: a status change with no live claim means "new in this stage."
  -- If a lease is currently held, the lease trigger will overwrite this to
  -- 'active' on the next lease event — but we don't want to lie about it
  -- here. (For status transitions that happen WHILE a lease is alive, the
  -- lease's continued existence keeps maturity='active' via the explicit
  -- guard below.)
  IF EXISTS (
    SELECT 1 FROM roadmap_proposal.proposal_lease
     WHERE proposal_id = NEW.id
       AND released_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    NEW.maturity := 'active';
  ELSE
    NEW.maturity := 'new';
  END IF;

  RETURN NEW;
END;
$$;

-- ─── 2. trg_lease_set_maturity_active ───────────────────────────────────
-- When a fresh lease is inserted (released_at IS NULL by default), flip
-- the proposal to maturity='active'. This is the only path to 'active'.
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
       AND maturity <> 'obsolete';      -- don't unstick obsolete rows
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lease_set_maturity_active
  ON roadmap_proposal.proposal_lease;
CREATE TRIGGER trg_lease_set_maturity_active
AFTER INSERT ON roadmap_proposal.proposal_lease
FOR EACH ROW
EXECUTE FUNCTION roadmap_proposal.fn_lease_set_maturity_active();

-- ─── 3. trg_lease_clear_maturity_on_release ─────────────────────────────
-- When a lease releases, recompute maturity from release_reason — but
-- only if no other alive lease exists for the proposal.
-- Alive-lease check uses (expires_at IS NULL OR expires_at > now()) to
-- correctly handle no-TTL leases where expires_at is NULL.
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_lease_clear_maturity_on_release()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_other_alive_count int;
  v_status            text;
  v_new_maturity      text;
BEGIN
  -- Only fire on the released_at NULL→NOT NULL transition.
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_other_alive_count
    FROM roadmap_proposal.proposal_lease
   WHERE proposal_id = NEW.proposal_id
     AND id <> NEW.id
     AND released_at IS NULL
     AND (expires_at IS NULL OR expires_at > now());

  IF v_other_alive_count > 0 THEN
    -- Another agent still holds the proposal — leave maturity='active'.
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM roadmap_proposal.proposal
   WHERE id = NEW.proposal_id;

  -- Terminal status — fall through to the COMPLETE/MERGED/etc. branch
  -- (handled by the proposal-level sync trigger on the next status
  -- write); for now mark mature so the field is honest.
  IF v_status IN ('DEPLOYED','COMPLETE','CLOSED','MERGED','RECYCLED') THEN
    v_new_maturity := 'mature';
  ELSIF v_status IN ('REJECTED','DISCARDED','ABANDONED') THEN
    v_new_maturity := 'obsolete';
  ELSIF NEW.release_reason IN ('work_delivered','gate_review_complete') THEN
    -- Agent finished work or a gate signed off — call for next gate.
    v_new_maturity := 'mature';
  ELSE
    -- gate_hold, gate_reject, lease_expired, manual_release, etc. — back to queue.
    v_new_maturity := 'new';
  END IF;

  UPDATE roadmap_proposal.proposal
     SET maturity = v_new_maturity
   WHERE id = NEW.proposal_id
     AND maturity <> 'obsolete';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lease_clear_maturity_on_release
  ON roadmap_proposal.proposal_lease;
CREATE TRIGGER trg_lease_clear_maturity_on_release
AFTER UPDATE OF released_at ON roadmap_proposal.proposal_lease
FOR EACH ROW
EXECUTE FUNCTION roadmap_proposal.fn_lease_clear_maturity_on_release();

-- ─── 4. One-shot reclaim sweep ──────────────────────────────────────────
-- Fix the existing 95 stuck rows. Strategy:
--   - status=COMPLETE/MERGED/etc. → 'mature'  (terminal cleanup)
--   - last lease release_reason in (work_delivered,gate_review_complete)
--                                  → 'mature' (ready for gate)
--   - everything else              → 'new'    (back to queue)
-- Alive-lease check uses (expires_at IS NULL OR expires_at > now()) to
-- match fn_check_lease_uniqueness (baseline line 181) and handle no-TTL leases.

WITH stuck AS (
  SELECT p.id, p.status,
         (SELECT release_reason
            FROM roadmap_proposal.proposal_lease
           WHERE proposal_id = p.id
             AND released_at IS NOT NULL
           ORDER BY released_at DESC
           LIMIT 1) AS last_release_reason
    FROM roadmap_proposal.proposal p
   WHERE p.maturity = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM roadmap_proposal.proposal_lease l
        WHERE l.proposal_id = p.id
          AND l.released_at IS NULL
          AND (l.expires_at IS NULL OR l.expires_at > now())
     )
)
UPDATE roadmap_proposal.proposal p
   SET maturity = CASE
     WHEN s.status IN ('DEPLOYED','COMPLETE','CLOSED','MERGED','RECYCLED') THEN 'mature'
     WHEN s.last_release_reason IN ('work_delivered','gate_review_complete') THEN 'mature'
     ELSE 'new'
   END
  FROM stuck s
 WHERE p.id = s.id;

COMMIT;
