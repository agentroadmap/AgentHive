-- P248: Board workflow columns and proposal stage dwell tracking.

BEGIN;

ALTER TABLE roadmap.workflow_stages
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_stage_dwell (
  id            BIGSERIAL PRIMARY KEY,
  proposal_id   BIGINT       NOT NULL REFERENCES roadmap_proposal.proposal(id),
  stage_name    TEXT         NOT NULL,
  entered_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  exited_at     TIMESTAMPTZ,
  dwell_seconds BIGINT GENERATED ALWAYS AS (
    CASE
      WHEN exited_at IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (exited_at - entered_at))::BIGINT
    END
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_proposal
  ON roadmap_proposal.proposal_stage_dwell(proposal_id);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_stage
  ON roadmap_proposal.proposal_stage_dwell(stage_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_dwell_one_open
  ON roadmap_proposal.proposal_stage_dwell(proposal_id)
  WHERE exited_at IS NULL;

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_track_proposal_stage_dwell()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  UPDATE roadmap_proposal.proposal_stage_dwell
  SET exited_at = v_now
  WHERE proposal_id = NEW.id
    AND exited_at IS NULL;

  IF NOT FOUND AND OLD.status IS NOT NULL THEN
    INSERT INTO roadmap_proposal.proposal_stage_dwell
      (proposal_id, stage_name, entered_at, exited_at)
    VALUES
      (NEW.id, OLD.status, COALESCE(OLD.modified_at, OLD.created_at, v_now), v_now);
  END IF;

  INSERT INTO roadmap_proposal.proposal_stage_dwell
    (proposal_id, stage_name, entered_at)
  VALUES
    (NEW.id, NEW.status, v_now)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_dwell_track ON roadmap_proposal.proposal;

CREATE TRIGGER trg_proposal_dwell_track
  AFTER UPDATE OF status ON roadmap_proposal.proposal
  FOR EACH ROW
  EXECUTE FUNCTION roadmap_proposal.fn_track_proposal_stage_dwell();

CREATE OR REPLACE VIEW roadmap_proposal.v_stage_dwell_stats AS
SELECT
  stage_name,
  COUNT(*)                                  AS proposal_count,
  ROUND(AVG(dwell_seconds) / 86400.0, 1)    AS avg_dwell_days,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP
        (ORDER BY dwell_seconds) / 86400.0, 1) AS median_dwell_days,
  MAX(dwell_seconds) / 86400                AS max_dwell_days
FROM roadmap_proposal.proposal_stage_dwell
WHERE exited_at IS NOT NULL
GROUP BY stage_name;

COMMENT ON TABLE roadmap_proposal.proposal_stage_dwell IS
  'P248: one row per proposal stage visit for board dwell statistics.';

COMMENT ON VIEW roadmap_proposal.v_stage_dwell_stats IS
  'P248: completed-stage dwell aggregates for board workflow visualization.';

GRANT SELECT ON roadmap_proposal.proposal_stage_dwell TO roadmap_agent;
GRANT SELECT ON roadmap_proposal.v_stage_dwell_stats TO roadmap_agent;

COMMIT;
