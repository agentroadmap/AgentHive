-- P248: proposal stage dwell tracking + statistics view

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_stage_dwell (
  id            BIGSERIAL PRIMARY KEY,
  proposal_id   BIGINT      NOT NULL
                  REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE,
  stage_name    TEXT        NOT NULL,
  entered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at     TIMESTAMPTZ,
  dwell_seconds BIGINT GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (exited_at - entered_at))::BIGINT
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_proposal
  ON roadmap_proposal.proposal_stage_dwell(proposal_id);
CREATE INDEX IF NOT EXISTS idx_stage_dwell_stage
  ON roadmap_proposal.proposal_stage_dwell(stage_name);

-- Trigger function: close old dwell row, open new one on status change.
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_proposal_dwell_track()
RETURNS trigger LANGUAGE plpgsql AS $$
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

DROP TRIGGER IF EXISTS trg_proposal_dwell_track ON roadmap_proposal.proposal;
CREATE TRIGGER trg_proposal_dwell_track
  AFTER UPDATE OF status ON roadmap_proposal.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap_proposal.fn_proposal_dwell_track();

-- Statistics view: completed dwell rows only (exited_at IS NOT NULL).
CREATE OR REPLACE VIEW roadmap_proposal.v_stage_dwell_stats AS
SELECT
  stage_name,
  COUNT(*) AS proposal_count,
  ROUND(AVG(dwell_seconds) / 86400.0, 1) AS avg_dwell_days,
  ROUND(
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dwell_seconds) / 86400.0,
    1
  ) AS median_dwell_days,
  MAX(dwell_seconds) / 86400 AS max_dwell_days
FROM roadmap_proposal.proposal_stage_dwell
WHERE exited_at IS NOT NULL
GROUP BY stage_name;
