-- P248: Board workflow visualization — proposal_stage_dwell tracking
--
-- Creates the dwell-tracking table, view, and trigger so we can measure how
-- long proposals spend in each workflow stage.  Required for the board
-- dwell-stats panel and per-stage analytics.
--
-- Hard-delete is not applicable here: dwell rows are historical records and
-- should outlive proposal moves.  The trigger closes the open row on status
-- transition and immediately opens a new one.
--
-- Backfill: inserts an open row for every proposal's *current* status using
-- COALESCE(modified_at, created_at) as entered_at.  If a proposal has already
-- been seen in the current stage this is a no-op due to the NOT EXISTS guard.

BEGIN;

-- ── 1. Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_stage_dwell (
  id            BIGSERIAL PRIMARY KEY,
  proposal_id   BIGINT      NOT NULL
                  REFERENCES roadmap_proposal.proposal(id)
                  ON DELETE CASCADE,
  stage_name    TEXT        NOT NULL,
  entered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at     TIMESTAMPTZ,
  dwell_seconds BIGINT
    GENERATED ALWAYS AS (
      EXTRACT(EPOCH FROM (exited_at - entered_at))::BIGINT
    ) STORED
);

COMMENT ON TABLE roadmap_proposal.proposal_stage_dwell IS
  'Time-in-stage history for proposals.  Each row covers one stay in a stage.  '
  'Open rows (exited_at IS NULL) represent the current stage.';

-- ── 2. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_stage_dwell_proposal
  ON roadmap_proposal.proposal_stage_dwell (proposal_id);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_stage
  ON roadmap_proposal.proposal_stage_dwell (stage_name);

-- ── 3. View: per-stage aggregate stats ───────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_stage_dwell_stats AS
SELECT
  stage_name,
  COUNT(*)                                                   AS proposal_count,
  ROUND(AVG(dwell_seconds)  / 86400.0, 1)                   AS avg_dwell_days,
  ROUND(
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dwell_seconds)
    / 86400.0, 1
  )                                                          AS median_dwell_days,
  MAX(dwell_seconds) / 86400                                 AS max_dwell_days
FROM roadmap_proposal.proposal_stage_dwell
WHERE exited_at IS NOT NULL
GROUP BY stage_name;

COMMENT ON VIEW roadmap_proposal.v_stage_dwell_stats IS
  'Aggregate dwell statistics per stage (completed stays only).';

-- ── 4. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_track_proposal_dwell()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- INSERT path: seed the initial open dwell row for the new proposal's stage.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name)
    VALUES (NEW.id, NEW.status);
    RETURN NEW;
  END IF;

  -- UPDATE path: no-op if status hasn't actually changed.
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  -- Close the open dwell row for the stage we're leaving.
  UPDATE roadmap_proposal.proposal_stage_dwell
  SET    exited_at = now()
  WHERE  proposal_id = OLD.id
    AND  stage_name  = OLD.status
    AND  exited_at  IS NULL;

  -- Open a new dwell row for the stage we're entering.
  INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name)
  VALUES (NEW.id, NEW.status);

  RETURN NEW;
END;
$fn$;

-- ── 5. Trigger ────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_proposal_dwell_track ON roadmap_proposal.proposal;

CREATE TRIGGER trg_proposal_dwell_track
  AFTER INSERT OR UPDATE OF status ON roadmap_proposal.proposal
  FOR EACH ROW
  EXECUTE FUNCTION roadmap_proposal.fn_track_proposal_dwell();

-- ── 6. Backfill: open rows for existing proposals' current stage ──────────────
-- Uses modified_at as entered_at when available (closest proxy for when the
-- proposal last changed stage), falling back to created_at.
-- Guard: skips any proposal that already has an open row in its current stage
-- (safe to re-run).

INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name, entered_at)
SELECT
  p.id,
  p.status,
  COALESCE(p.modified_at, p.created_at, now())
FROM roadmap_proposal.proposal p
WHERE NOT EXISTS (
  SELECT 1
  FROM   roadmap_proposal.proposal_stage_dwell d
  WHERE  d.proposal_id = p.id
    AND  d.stage_name  = p.status
    AND  d.exited_at  IS NULL
);

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*)::INT INTO v_count
  FROM   roadmap_proposal.proposal_stage_dwell
  WHERE  exited_at IS NULL;
  RAISE NOTICE 'P248 backfill: % open dwell rows after backfill', v_count;
END;
$$;

COMMIT;
