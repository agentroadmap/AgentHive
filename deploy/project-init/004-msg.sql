-- ============================================================
-- project-init/004-msg.sql
-- Project-scoped messaging: mMessage, mTopic, mDLQ.
-- Run with: psql -v schema_name=agentHive -f 004-msg.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- mTopic — message topic / channel registry
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.mTopic (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL UNIQUE,          -- 'proposal-updates', 'gate-events', etc.
  description      TEXT,
  retention_days   INT          NOT NULL DEFAULT 90,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER set_updated_at_mtopic
  BEFORE UPDATE ON :schema_name.mTopic
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.mTopic IS
  'Message topic registry. mMessage rows are published to a topic.';

-- ============================================================
-- mMessage — agent-to-agent messages
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.mMessage (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic_id         BIGINT       REFERENCES :schema_name.mTopic (id) ON DELETE SET NULL,
  from_agent       TEXT         NOT NULL,
  to_agent         TEXT,                                  -- NULL = broadcast to topic
  kind             TEXT         NOT NULL,                 -- 'task', 'event', 'notify', 'request', 'reply'
  payload_jsonb    JSONB        NOT NULL DEFAULT '{}',
  correlation_id   TEXT,                                  -- groups request/reply pairs
  sent_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ,
  ack_at           TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  retry_count      INT          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS mmessage_topic ON :schema_name.mMessage (topic_id, sent_at);
CREATE INDEX IF NOT EXISTS mmessage_to_agent ON :schema_name.mMessage (to_agent)
  WHERE ack_at IS NULL AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS mmessage_correlation ON :schema_name.mMessage (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE :schema_name.mMessage IS
  'Agent-to-agent messages. Undelivered messages are visible via to_agent + ack_at IS NULL filter.';

-- ============================================================
-- mDLQ — dead letter queue (messages that exhausted retries)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.mDLQ (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_msg_id  BIGINT,                                -- original mMessage.id if available
  topic_id         BIGINT       REFERENCES :schema_name.mTopic (id) ON DELETE SET NULL,
  from_agent       TEXT         NOT NULL,
  to_agent         TEXT,
  kind             TEXT         NOT NULL,
  payload_jsonb    JSONB        NOT NULL DEFAULT '{}',
  failure_reason   TEXT,
  retry_count      INT          NOT NULL DEFAULT 0,
  failed_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  replays          INT          NOT NULL DEFAULT 0,
  expired_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mdlq_failed_at ON :schema_name.mDLQ (failed_at);
CREATE INDEX IF NOT EXISTS mdlq_original ON :schema_name.mDLQ (original_msg_id);

COMMENT ON TABLE :schema_name.mDLQ IS
  'Dead letter queue. Messages land here after exhausting retries. Inspected manually or by reconciler.';

-- Add columns if table already exists
ALTER TABLE IF EXISTS :schema_name.mDLQ ADD COLUMN IF NOT EXISTS replays INT NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS :schema_name.mDLQ ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

-- Index for stuck liaison messages (unprocessed)
CREATE INDEX IF NOT EXISTS msg_stuck_liaison
  ON agency.msg_default (sent_at)
  WHERE processed_at IS NULL;
