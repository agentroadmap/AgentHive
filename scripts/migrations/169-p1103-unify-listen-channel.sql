-- P1103 AC-2: Unify LISTEN channel namespace to msg_<identity> on PGPORT_DIRECT.
--
-- Before:
--   liaison_message trigger → pg_notify('liaison_message_' || agency_id, ...)
--   fn_a2a_message_notify   → pg_notify('a2a_msg_'         || to_agent,  ...)
--
-- After:
--   liaison_message trigger → pg_notify('msg_' || agency_id, ...)
--   fn_a2a_message_notify   → pg_notify('msg_' || to_agent,  ...)
--
-- Both TypeScript listeners update simultaneously:
--   liaison-message-service.ts LISTEN_CHANNEL_PREFIX: 'liaison_message_' → 'msg_'
--   a2a-access-control.ts agentNotifyChannel():       'a2a_msg_'         → 'msg_'
--
-- Rollout: rename triggers first; agencies re-subscribe on next restart.
-- Old liaison_message_* / a2a_msg_* channels receive no more NOTIFYs.

-- 1. Update the liaison_message INSERT trigger to fire msg_<agency_id>
CREATE OR REPLACE FUNCTION roadmap.fn_liaison_notify_new_message()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'msg_' || NEW.agency_id,
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

-- 2. Update fn_a2a_message_notify to fire msg_<to_agent> for DMs.
--    All other branches (team/broadcast/liaison/discord) are unchanged.
CREATE OR REPLACE FUNCTION roadmap.fn_a2a_message_notify()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- DM: wake the recipient on msg_<to_agent>. MUST match
    -- agentNotifyChannel() in src/infra/messaging/a2a-access-control.ts.
    IF NEW.to_agent IS NOT NULL THEN
        PERFORM pg_notify(
            'msg_' || NEW.to_agent,
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
