-- P199: Secure A2A Communication — Targeted Delivery & Access Control
--
-- AC#1: Adds nonce + sender_sig columns to message_ledger for typed, signed envelopes.
-- AC#2: Creates message_acl table — senders may only deliver to ACL-permitted recipients.
-- AC#3: Replaces fn_notify_new_message trigger to use per-agent channels with NO broadcast fallback.
-- AC#4: nonce uniqueness index prevents replay attacks; sender_sig enables spoofing detection.

BEGIN;

-- ─── AC#1 / AC#4: Envelope security fields ────────────────────────────────────

ALTER TABLE roadmap.message_ledger
    ADD COLUMN IF NOT EXISTS nonce      uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS sender_sig text NULL;

-- Unique nonce prevents replay attacks: duplicate nonce = rejected at insert
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_ledger_nonce
    ON roadmap.message_ledger (nonce);

-- ─── AC#2: Access Control List ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.message_acl (
    id          bigserial   PRIMARY KEY,
    from_agent  text        NOT NULL,   -- sender being granted permission
    to_agent    text        NOT NULL,   -- recipient ('*' = any registered agent)
    grant_type  text        NOT NULL DEFAULT 'dm'
        CONSTRAINT message_acl_grant_type_check
            CHECK (grant_type IN ('dm', 'channel_post', 'system')),
    granted_by  text        NOT NULL,   -- admin agent that created the grant
    granted_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz NULL,       -- NULL = active grant
    CONSTRAINT message_acl_pair_uq UNIQUE (from_agent, to_agent, grant_type)
);

-- Fast lookup: all active grants for a given sender
CREATE INDEX IF NOT EXISTS idx_message_acl_from_active
    ON roadmap.message_acl (from_agent)
    WHERE revoked_at IS NULL;

-- Fast lookup: grant for a specific sender→recipient pair
CREATE INDEX IF NOT EXISTS idx_message_acl_pair_active
    ON roadmap.message_acl (from_agent, to_agent)
    WHERE revoked_at IS NULL;

-- Seed: system-level agents bypass ACL and may send to any recipient
INSERT INTO roadmap.message_acl (from_agent, to_agent, grant_type, granted_by) VALUES
    ('system',        '*', 'dm',           'system'),
    ('system',        '*', 'channel_post', 'system'),
    ('system',        '*', 'system',       'system'),
    ('orchestrator',  '*', 'dm',           'system'),
    ('orchestrator',  '*', 'channel_post', 'system'),
    ('orchestrator',  '*', 'system',       'system')
ON CONFLICT ON CONSTRAINT message_acl_pair_uq DO NOTHING;

-- ─── AC#3: Targeted pg_notify — no broadcast fallback ─────────────────────────
--
-- Channel naming convention: 'agent_msg_' || regexp_replace(agent_identity, '[^a-zA-Z0-9_]', '_', 'g')
-- Example: 'claude/agency-bot' → 'agent_msg_claude_agency_bot'
--
-- DM (to_agent IS NOT NULL):
--   Notifies ONLY the recipient's dedicated channel. No other agent receives the push.
--
-- Channel message (to_agent IS NULL, channel IS NOT NULL):
--   Iterates channel_subscription and notifies each subscriber's dedicated channel.
--   Non-subscribers receive no push.
--
-- No fallback to 'new_message' channel under any condition.

CREATE OR REPLACE FUNCTION roadmap.fn_notify_new_message() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    v_notify_channel text;
    v_payload        text;
    v_sub            record;
BEGIN
    v_payload := jsonb_build_object(
        'message_id',   NEW.id,
        'from_agent',   NEW.from_agent,
        'to_agent',     NEW.to_agent,
        'channel',      NEW.channel,
        'message_type', COALESCE(NEW.message_type, 'text'),
        'proposal_id',  NEW.proposal_id,
        'nonce',        NEW.nonce,
        'created_at',   NEW.created_at
    )::text;

    IF NEW.to_agent IS NOT NULL THEN
        -- Direct message: notify recipient's dedicated channel only
        v_notify_channel := 'agent_msg_' ||
            regexp_replace(NEW.to_agent, '[^a-zA-Z0-9_]', '_', 'g');
        PERFORM pg_notify(v_notify_channel, v_payload);

    ELSIF NEW.channel IS NOT NULL THEN
        -- Channel message: fan-out to each subscriber's dedicated channel
        FOR v_sub IN
            SELECT cs.agent_identity
            FROM   roadmap.channel_subscription cs
            WHERE  cs.channel = NEW.channel
        LOOP
            v_notify_channel := 'agent_msg_' ||
                regexp_replace(v_sub.agent_identity, '[^a-zA-Z0-9_]', '_', 'g');
            PERFORM pg_notify(v_notify_channel, v_payload);
        END LOOP;
    END IF;

    -- Intentionally no fallback to 'new_message'. Blast-radius eliminated.
    RETURN NEW;
END;
$$;

COMMIT;
