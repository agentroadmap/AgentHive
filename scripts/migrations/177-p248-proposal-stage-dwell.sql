-- P248: Board workflow visualization — dwell tracking + is_active on workflow_stages
-- Migration 177

-- AC-7: Add is_active to roadmap.workflow_stages
ALTER TABLE roadmap.workflow_stages
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- proposal_stage_dwell: one row per (proposal, stage) stint
CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_stage_dwell (
  id              BIGSERIAL PRIMARY KEY,
  proposal_id     BIGINT      NOT NULL REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE,
  stage_name      TEXT        NOT NULL,
  entered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at       TIMESTAMPTZ,
  dwell_seconds   BIGINT GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (exited_at - entered_at))::BIGINT
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_proposal
  ON roadmap_proposal.proposal_stage_dwell(proposal_id);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_stage
  ON roadmap_proposal.proposal_stage_dwell(stage_name);

-- Backfill open rows for all proposals currently in a stage
INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name, entered_at)
SELECT id, status, COALESCE(modified_at, created_at)
FROM   roadmap_proposal.proposal
ON CONFLICT DO NOTHING;

-- v_stage_dwell_stats: per-stage aggregate over completed stints
CREATE OR REPLACE VIEW roadmap_proposal.v_stage_dwell_stats AS
SELECT
  stage_name,
  COUNT(*) AS proposal_count,
  ROUND((AVG(dwell_seconds) / 86400.0)::numeric, 1) AS avg_dwell_days,
  ROUND(
    (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dwell_seconds) / 86400.0)::numeric,
    1
  ) AS median_dwell_days,
  MAX(dwell_seconds) / 86400 AS max_dwell_days
FROM  roadmap_proposal.proposal_stage_dwell
WHERE exited_at IS NOT NULL
GROUP BY stage_name;

-- fn_proposal_dwell_track: close the open row on OLD.status, open one for NEW.status
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_proposal_dwell_track()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- no-op when status unchanged
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  -- close the open dwell row for the departing stage
  UPDATE roadmap_proposal.proposal_stage_dwell
     SET exited_at = now()
   WHERE proposal_id = OLD.id
     AND stage_name  = OLD.status
     AND exited_at  IS NULL;

  -- open a new dwell row for the arriving stage
  INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name, entered_at)
  VALUES (NEW.id, NEW.status, now());

  RETURN NEW;
END;
$$;

-- trg_proposal_dwell_track: fires after status changes
DROP TRIGGER IF EXISTS trg_proposal_dwell_track ON roadmap_proposal.proposal;
CREATE TRIGGER trg_proposal_dwell_track
  AFTER UPDATE OF status ON roadmap_proposal.proposal
  FOR EACH ROW
  EXECUTE FUNCTION roadmap_proposal.fn_proposal_dwell_track();

-- Grants so the web server role can read
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_readonly') THEN
    GRANT SELECT ON roadmap_proposal.proposal_stage_dwell TO roadmap_readonly;
    GRANT SELECT ON roadmap_proposal.v_stage_dwell_stats  TO roadmap_readonly;
  END IF;
END;
$$;
