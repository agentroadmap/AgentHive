-- P1017 AC-3 / AC-4: Unify pg_notify channel namespace to a2a_msg_*.
--
-- Two trigger functions were firing on the wrong channel:
--
--   fn_a2a_message_notify (on message_ledger):
--     Was firing 'msg_' || to_agent — MUST be 'a2a_msg_' to match
--     agentNotifyChannel() in a2a-access-control.ts and all LISTENers.
--     Migration 119 (P888) deployed the correct 'a2a_msg_' version but the
--     live DB was subsequently overwritten with the old 'msg_' prefix.
--
--   fn_liaison_notify_new_message (on liaison_message):
--     Was firing 'msg_' || agency_id — changed to 'a2a_msg_' so that
--     liaison-message-service.ts (and liaison-hub) can use one LISTEN prefix
--     for both the downlink (message_ledger) and uplink (liaison_message) paths.
--
-- After this migration:
--   - All per-agent pg_notify events fire on a2a_msg_<identity>.
--   - TS LISTEN_CHANNEL_PREFIX can be set to 'a2a_msg_' (done in liaison-message-service.ts).
--   - 'liaison_message' table is retained but marked deprecated (P1017 AC-3 retirement
--     is a follow-on once all callers have migrated to message_ledger).

-- 1. Restore fn_a2a_message_notify to fire 'a2a_msg_' prefix (P888 intent).
CREATE OR REPLACE FUNCTION roadmap.fn_a2a_message_notify()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- DM: wake the recipient on a2a_msg_<to_agent>. MUST match
    -- agentNotifyChannel() in src/infra/messaging/a2a-access-control.ts.
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

    -- Liaison subchannel: wakes the liaison hub listening on a2a_chan_system:liaison:<agencyId>.
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

    -- P923: External Discord outbound.
    IF NEW.to_agent LIKE 'external/discord/%' THEN
        IF EXISTS (
            SELECT 1 FROM roadmap.external_routing er
            WHERE er.channel_kind = 'discord'
              AND er.external_id = split_part(NEW.to_agent, '/', 3)
              AND er.is_active = true
        ) THEN
            PERFORM pg_notify(
                'external_discord_outbound',
                NEW.id::text
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- 2. Fix fn_liaison_notify_new_message to fire 'a2a_msg_' prefix.
CREATE OR REPLACE FUNCTION roadmap.fn_liaison_notify_new_message()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Uplink notification: agency → liaison hub on a2a_msg_<agency_id>.
    -- Matches LISTEN_CHANNEL_PREFIX='a2a_msg_' in liaison-message-service.ts.
    PERFORM pg_notify(
        'a2a_msg_' || NEW.agency_id,
        json_build_object(
            'message_id', NEW.message_id,
            'direction',  NEW.direction,
            'kind',       NEW.kind,
            'sequence',   NEW.sequence
        )::text
    );
    IF NEW.host_id IS NOT NULL THEN
        PERFORM pg_notify(
            roadmap.fn_host_dispatch_channel(NEW.host_id),
            json_build_object(
                'message_id', NEW.message_id,
                'agency_id',  NEW.agency_id,
                'direction',  NEW.direction,
                'kind',       NEW.kind,
                'sequence',   NEW.sequence
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$;

-- Verify: both functions now use 'a2a_msg_' prefix.
-- SELECT 'fn_a2a_message_notify' AS func,
--        (prosrc LIKE '%a2a_msg_%') AS uses_a2a_prefix
-- FROM pg_proc WHERE proname = 'fn_a2a_message_notify'
-- UNION ALL
-- SELECT 'fn_liaison_notify_new_message',
--        (prosrc LIKE '%a2a_msg_%')
-- FROM pg_proc WHERE proname = 'fn_liaison_notify_new_message';
