-- env: prod
-- P924 — Session metadata column for cursor bookkeeping + dead-letter view

BEGIN;

ALTER TABLE roadmap.agency_liaison_session
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN roadmap.agency_liaison_session.metadata IS
  'JSONB bag for cursor bookkeeping (drain_cursor_created_at, drain_cursor_id) and other session-scoped state. P924 owns this column; other proposals may write keys without further migration.';

CREATE OR REPLACE VIEW roadmap.v_liaison_message_unacked_dead_letter AS
  SELECT message_id, agency_id, host_id, kind, direction, sequence, created_at
    FROM roadmap.liaison_message
   WHERE acked_at IS NULL
     AND created_at < now() - interval '1 hour';

COMMIT;
