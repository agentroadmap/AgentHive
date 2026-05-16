-- P1017 AC-2: Prune historical heartbeat-mirror rows from message_ledger.
-- These were written by old agency code that mirrored heartbeats into the
-- message bus. fn_pulse now owns presence state; no new rows land here.
-- Keeps the last 10 for forensic reference (message_type audit).

DO $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM roadmap.message_ledger
  WHERE id IN (
    SELECT id FROM roadmap.message_ledger
    WHERE message_type = 'event' AND message_content = 'heartbeat'
    ORDER BY id DESC
    OFFSET 10
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'P1017 AC-2: pruned % historical heartbeat rows from message_ledger', v_deleted;
END;
$$;

-- Verify: no heartbeat rows except the forensic tail.
-- SELECT count(*) FROM roadmap.message_ledger
-- WHERE message_type='event' AND message_content='heartbeat' AND created_at < now() - interval '1 hour';
