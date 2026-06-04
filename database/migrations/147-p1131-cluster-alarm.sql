-- Migration 147: P1131 — gate-review cluster-detection alarm
-- Fires pg_notify('control_feed', ...) when the same reviewer issues >=3 approves
-- within a 60-second window. Alert fires at multiples of 3 (3, 6, 9 …) to avoid
-- a notify storm if rubber-stamping continues past the first trigger.
--
-- Payload schema: {event_type: 'gate_review_cluster', reviewer_identity: <text>,
--   window_seconds: 60, approve_count: <int>, latest_proposal_id: <int>, ts: <timestamptz>}

-- Index required by the trigger's window-count query (AC-1).
CREATE INDEX IF NOT EXISTS idx_proposal_reviews_reviewer_timestamp
  ON roadmap_proposal.proposal_reviews (reviewer_identity, reviewed_at);

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_gate_review_cluster_detect()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count  bigint;
BEGIN
  -- Only care about approvals.
  IF NEW.verdict <> 'approve' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO v_count
    FROM roadmap_proposal.proposal_reviews
   WHERE reviewer_identity = NEW.reviewer_identity
     AND verdict           = 'approve'
     AND reviewed_at       > NEW.reviewed_at - interval '60 seconds'
     AND reviewed_at       <= NEW.reviewed_at;

  -- Fire at 3, 6, 9 … to throttle the alert channel.
  IF v_count >= 3 AND (v_count % 3) = 0 THEN
    PERFORM pg_notify(
      'control_feed',
      json_build_object(
        'event_type',        'gate_review_cluster',
        'reviewer_identity', NEW.reviewer_identity,
        'window_seconds',    60,
        'approve_count',     v_count,
        'latest_proposal_id', NEW.proposal_id,
        'ts',                now()
      )::text
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_proposal_review_cluster_detect
  ON roadmap_proposal.proposal_reviews;

CREATE TRIGGER tg_proposal_review_cluster_detect
  AFTER INSERT
  ON roadmap_proposal.proposal_reviews
  FOR EACH ROW
  EXECUTE FUNCTION roadmap_proposal.fn_gate_review_cluster_detect();
