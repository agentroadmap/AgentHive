-- Migration 045: Trust Enforcement - Denied Messages Table (P209)
-- Records blocked messages and provides fast lookup for escalation detection.

BEGIN;

-- Create denied_messages table in roadmap_messaging schema
CREATE TABLE IF NOT EXISTS roadmap_messaging.denied_messages (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_agent      text        NOT NULL REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT,
    to_agent        text        NOT NULL REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT,
    message_type    text        NOT NULL,
    reason          text        NOT NULL,
    trust_tier      text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup for escalation detection: recent denials per agent pair
CREATE INDEX idx_denied_messages_agent_pair
    ON roadmap_messaging.denied_messages (from_agent, to_agent, created_at DESC);

-- Single-agent denial counting (for broadcast/channel denials)
CREATE INDEX idx_denied_messages_from_agent
    ON roadmap_messaging.denied_messages (from_agent, created_at DESC);

-- Cleanup: auto-purge old entries after 7 days via pg_cron (optional, manual for now)
-- SELECT cron.schedule('purge-denied-messages', '0 3 * * *',
--   $$DELETE FROM roadmap_messaging.denied_messages WHERE created_at < now() - interval '7 days'$$);

COMMIT;
