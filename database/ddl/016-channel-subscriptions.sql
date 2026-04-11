-- =============================================================================
-- Migration 016: Channel Subscriptions & Push Notifications (P149)
-- =============================================================================
-- Adds:
--   1. channel_subscription table — agents subscribe to channels
--   2. fn_notify_new_message() — pg_notify trigger on message_ledger INSERT
--   3. Trigger trg_message_notify — fires after every message insert
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. channel_subscription table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roadmap.channel_subscription (
    agent_identity  TEXT        NOT NULL,
    channel         TEXT        NOT NULL,
    subscribed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT channel_subscription_pkey
        PRIMARY KEY (agent_identity, channel),
    CONSTRAINT channel_subscription_agent_fkey
        FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity)
        ON DELETE CASCADE,
    CONSTRAINT channel_subscription_channel_check
        CHECK (channel ~ '^(direct|team:.+|broadcast|system)$')
);

CREATE INDEX idx_channel_subscription_channel
    ON roadmap.channel_subscription (channel);

COMMENT ON TABLE  roadmap.channel_subscription IS 'P149: Agents subscribed to channels for push notifications via pg_notify';
COMMENT ON COLUMN roadmap.channel_subscription.agent_identity IS 'FK to agent_registry — the subscribing agent';
COMMENT ON COLUMN roadmap.channel_subscription.channel IS 'Channel pattern: direct, team:<name>, broadcast, system';

-- ---------------------------------------------------------------------------
-- 2. Trigger function: notify on new message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_notify_new_message()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'new_message',
        jsonb_build_object(
            'message_id',    NEW.id,
            'from_agent',    NEW.from_agent,
            'to_agent',      NEW.to_agent,
            'channel',       COALESCE(NEW.channel, 'broadcast'),
            'message_type',  COALESCE(NEW.message_type, 'text'),
            'proposal_id',   NEW.proposal_id,
            'created_at',    NEW.created_at
        )::text
    );
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Trigger: fire after INSERT on message_ledger
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_message_notify ON roadmap.message_ledger;

CREATE TRIGGER trg_message_notify
    AFTER INSERT ON roadmap.message_ledger
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_notify_new_message();

-- ---------------------------------------------------------------------------
-- Done
-- ---------------------------------------------------------------------------
