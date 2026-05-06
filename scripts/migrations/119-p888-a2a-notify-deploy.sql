-- Migration 119: Deploy A2A foundation gap (P888)
--
-- Lives in scripts/migrations/ — the canonical migration path post-P753 A6
-- cutover (commit 6725408d). database/migrations/ is LEGACY; do not add new
-- migrations there.
--
-- Background: P199/P833 are marked COMPLETE in roadmap.proposal but neither
-- the per-agent pg_notify trigger nor the message_ledger.nonce column was
-- actually deployed to hiveCentral. P833's foundation migration
-- (scripts/migrations/100-p833-a2a-messaging-foundation.sql) added
-- correlation_id, sig_verified, provider_sig, provider_sig_salt — but did
-- not add `nonce` and did not deploy `fn_a2a_message_notify`. The two
-- never-applied attempts (database/migrations/096, database/ddl/v4/055)
-- live in directories that no runner scans. As a result:
--
--   1. msg_send fails: pg-handlers.ts:281 does
--        INSERT INTO roadmap.message_ledger ... RETURNING id, nonce, created_at
--      and the deployed table has no `nonce` column. Every send via the MCP
--      tool returns "column 'nonce' does not exist" wrapped in errorResult().
--      Agents receive the failure as a text response and most do not abort.
--
--   2. msg_read(wait_ms=...) never wakes via pg_notify: the deployed trigger
--      `trg_message_notify` calls `fn_notify_new_message` which only emits on
--      the global 'new_message' channel. No consumer listens there. Every
--      blocking read times out (or polls slowly).
--
-- This migration is idempotent (CREATE OR REPLACE FUNCTION, IF NOT EXISTS,
-- DROP TRIGGER IF EXISTS, ON CONFLICT DO NOTHING) and additive (it leaves
-- the legacy trg_message_notify in place; removing that is a follow-up
-- once a zero-consumer audit confirms nothing relies on 'new_message').
--
-- The trigger emits on a2a_msg_<to_agent> for DMs, matching the channel
-- name produced by agentNotifyChannel() in
-- src/infra/messaging/a2a-access-control.ts and the LISTENers in cli.ts,
-- msg-wait-reply.ts, msg-reply.ts, agent-liveness.ts, server/index.ts,
-- scripts/start-message-agent.ts, scripts/start-claude-code-agency.ts.

BEGIN;

-- ─── 1. message_ledger.nonce (P199 AC#1 / AC#4 — replay prevention) ──────────

ALTER TABLE roadmap.message_ledger
    ADD COLUMN IF NOT EXISTS nonce uuid DEFAULT gen_random_uuid() NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_ledger_nonce
    ON roadmap.message_ledger (nonce);

-- ─── 2. fn_a2a_message_notify (per-agent pg_notify) ──────────────────────────

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

DROP TRIGGER IF EXISTS trig_a2a_message_notify ON roadmap.message_ledger;
CREATE TRIGGER trig_a2a_message_notify
AFTER INSERT ON roadmap.message_ledger
FOR EACH ROW EXECUTE FUNCTION roadmap.fn_a2a_message_notify();

-- ─── 3. ACL seed for system-level senders (idempotent) ───────────────────────

INSERT INTO roadmap.message_acl (from_agent, to_agent, grant_type, granted_by) VALUES
    ('system',        '*', 'dm',           'system'),
    ('system',        '*', 'channel_post', 'system'),
    ('system',        '*', 'system',       'system'),
    ('orchestrator',  '*', 'dm',           'system'),
    ('orchestrator',  '*', 'channel_post', 'system'),
    ('orchestrator',  '*', 'system',       'system')
ON CONFLICT ON CONSTRAINT message_acl_pair_uq DO NOTHING;

COMMIT;
