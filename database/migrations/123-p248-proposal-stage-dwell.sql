-- P248: Board workflow visualization — proposal stage dwell tracking
-- Tracks per-stage entry/exit timestamps for each proposal so the board
-- can display bottleneck analytics (avg/median/max dwell per stage).

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_stage_dwell (
  id            BIGSERIAL    PRIMARY KEY,
  proposal_id   BIGINT       NOT NULL REFERENCES roadmap_proposal.proposal(id),
  stage_name    TEXT         NOT NULL,
  entered_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  exited_at     TIMESTAMPTZ,
  -- dwell_seconds is safe as GENERATED because both operands are stored timestamps
  dwell_seconds BIGINT GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (exited_at - entered_at))::BIGINT
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_stage_dwell_proposal
  ON roadmap_proposal.proposal_stage_dwell(proposal_id);
CREATE INDEX IF NOT EXISTS idx_stage_dwell_stage
  ON roadmap_proposal.proposal_stage_dwell(stage_name);

-- ── Dwell stats view (completed transitions only) ─────────────────────────
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

-- ── Trigger function ─────────────────────────────────────────────────────────
-- Handles both INSERT (seed initial stage row) and UPDATE OF status
-- (close previous stage row, open new one).
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_proposal_dwell_track()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name)
    VALUES (NEW.id, NEW.status);
    RETURN NEW;
  END IF;

  -- UPDATE path: no-op when status is unchanged
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Close the open row for the previous stage
  UPDATE roadmap_proposal.proposal_stage_dwell
     SET exited_at = now()
   WHERE proposal_id = NEW.id
     AND stage_name  = OLD.status
     AND exited_at  IS NULL;

  -- Open a new row for the incoming stage
  INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name)
  VALUES (NEW.id, NEW.status);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_dwell_track ON roadmap_proposal.proposal;
CREATE TRIGGER trg_proposal_dwell_track
  AFTER INSERT OR UPDATE OF status
  ON roadmap_proposal.proposal
  FOR EACH ROW
  EXECUTE FUNCTION roadmap_proposal.fn_proposal_dwell_track();
