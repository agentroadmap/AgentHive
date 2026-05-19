-- Rollback 124: Discord external routing bridge (P923)
--
-- Drops external_routing, operator_principals, and external_routing_audit tables,
-- removes the external_discord_outbound branch from fn_a2a_message_notify,
-- and restores it to the pre-P923 version from migration 119.
--
-- Idempotent: uses DROP ... IF EXISTS, recreates the trigger with the original
-- function body, and removes the bridge/discord ACL seed.

BEGIN;

-- ─── 1. Drop external routing tables ─────────────────────────────────────────

DROP TABLE IF EXISTS roadmap.external_routing CASCADE;
DROP TABLE IF EXISTS roadmap.operator_principals CASCADE;
DROP TABLE IF EXISTS roadmap.external_routing_audit CASCADE;

-- ─── 2. Remove bridge/discord from message_acl ───────────────────────────────

DELETE FROM roadmap.message_acl
 WHERE from_agent = 'bridge/discord' AND to_agent = '*';

-- ─── 3. Restore fn_a2a_message_notify to pre-P923 version (from migration 119) ──

CREATE OR REPLACE FUNCTION roadmap.fn_a2a_message_notify()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- DM: wake the recipient on a2a_msg_<to_agent>. MUST match
    -- agentNotifyChannel() in src/infra/messaging/a2a-access-control.ts
    -- (see tests/integration/a2a-cross-process.test.ts for the canary).
    IF NEW.to_agent IS NOT NULL THEN
        PERFORM pg_notify(
            'a2a_msg_' || NEW.to_agent,
            json_build_object(
                'message_id',   NEW.id,
                'from_agent',   NEW.from_agent,
                'to_agent',     NEW.to_agent,
                'channel',      NEW.channel,
                'message_type', NEW.message_type,
                'nonce',        NEW.nonce,
                'created_at',   NEW.created_at
            )::text
        );
    END IF;

    -- Team channel.
    IF NEW.channel LIKE 'team:%' THEN
        PERFORM pg_notify(
            'a2a_chan_' || NEW.channel,
            json_build_object(
                'message_id', NEW.id,
                'from_agent', NEW.from_agent,
                'channel',    NEW.channel
            )::text
        );
    END IF;

    -- Broadcast.
    IF NEW.channel = 'broadcast' THEN
        PERFORM pg_notify(
            'a2a_chan_broadcast',
            json_build_object(
                'message_id', NEW.id,
                'from_agent', NEW.from_agent
            )::text
        );
    END IF;

    -- Liaison subchannel.
    IF NEW.channel LIKE 'system:liaison:%' THEN
        PERFORM pg_notify(
            'a2a_chan_' || NEW.channel,
            json_build_object(
                'message_id', NEW.id,
                'from_agent', NEW.from_agent,
                'channel',    NEW.channel
            )::text
        );
    END IF;

    RETURN NEW;
END;
$$;

-- Recreate the trigger with the restored function.
DROP TRIGGER IF EXISTS trig_a2a_message_notify ON roadmap.message_ledger;
CREATE TRIGGER trig_a2a_message_notify
AFTER INSERT ON roadmap.message_ledger
FOR EACH ROW EXECUTE FUNCTION roadmap.fn_a2a_message_notify();

-- ─── 4. Drop fn_liaison_message_send_v2 ─────────────────────────────────────

DROP FUNCTION IF EXISTS roadmap.fn_liaison_message_send_v2(
    TEXT, TEXT, TEXT, TEXT, JSONB, BYTEA, UUID
) CASCADE;

COMMIT;
