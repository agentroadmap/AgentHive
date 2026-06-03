-- P248 addendum: add INSERT path to fn_proposal_dwell_track so that newly
-- created proposals seed an open dwell row immediately.
-- Migration 143 only registered AFTER UPDATE OF status; this replaces the
-- function and trigger to also handle AFTER INSERT.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_proposal_dwell_track()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- INSERT path: open the first dwell row for the initial stage.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name)
    VALUES (NEW.id, NEW.status);
    RETURN NEW;
  END IF;

  -- UPDATE path: no-op when status is unchanged.
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  -- Close the open row for the departing stage.
  UPDATE roadmap_proposal.proposal_stage_dwell
     SET exited_at = now()
   WHERE proposal_id = OLD.id
     AND stage_name  = OLD.status
     AND exited_at  IS NULL;

  -- Open a new row for the arriving stage.
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
