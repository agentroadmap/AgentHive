-- ============================================================
-- project-init/004-msg.sql
-- Project-scoped messaging: m_message, m_topic, m_dlq.
-- Run with: psql -v schema_name=agentHive -f 004-msg.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- m_topic — message topic / channel registry
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.m_topic (
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
  BEFORE UPDATE ON :schema_name.m_topic
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.m_topic IS
  'Message topic registry. m_message rows are published to a topic.';

-- ============================================================
-- m_message — agent-to-agent messages
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.m_message (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic_id         BIGINT       REFERENCES :schema_name.m_topic (id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS mmessage_topic ON :schema_name.m_message (topic_id, sent_at);
CREATE INDEX IF NOT EXISTS mmessage_to_agent ON :schema_name.m_message (to_agent)
  WHERE ack_at IS NULL AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS mmessage_correlation ON :schema_name.m_message (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE :schema_name.m_message IS
  'Agent-to-agent messages. Undelivered messages are visible via to_agent + ack_at IS NULL filter.';

-- ============================================================
-- m_dlq — dead letter queue (messages that exhausted retries)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.m_dlq (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_msg_id  BIGINT,                                -- original m_message.id if available
  topic_id         BIGINT       REFERENCES :schema_name.m_topic (id) ON DELETE SET NULL,
  from_agent       TEXT         NOT NULL,
  to_agent         TEXT,
  kind             TEXT         NOT NULL,
  payload_jsonb    JSONB        NOT NULL DEFAULT '{}',
  failure_reason   TEXT,
  retry_count      INT          NOT NULL DEFAULT 0,
  failed_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdlq_failed_at ON :schema_name.m_dlq (failed_at);
CREATE INDEX IF NOT EXISTS mdlq_original ON :schema_name.m_dlq (original_msg_id);

COMMENT ON TABLE :schema_name.m_dlq IS
  'Dead letter queue. Messages land here after exhausting retries. Inspected manually or by reconciler.';
