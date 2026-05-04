-- Migration 096: A2A message_ledger pg_notify trigger
-- Enables trust-bound blocking reads (wait_ms) in msg_read tool.
-- Fires on INSERT into message_ledger, notifying per-agent and per-team-channel.

CREATE OR REPLACE FUNCTION roadmap.fn_a2a_message_notify()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- DM notification: wake the specific recipient
    IF NEW.to_agent IS NOT NULL THEN
        PERFORM pg_notify(
            'a2a_msg_' || NEW.to_agent,
            json_build_object(
                'message_id', NEW.id,
                'from_agent', NEW.from_agent,
                'channel', NEW.channel,
                'message_type', NEW.message_type
            )::text
        );
    END IF;

    -- Team/broadcast channel notification
    IF NEW.channel LIKE 'team:%' OR NEW.channel = 'broadcast' THEN
        PERFORM pg_notify(
            'a2a_chan_' || COALESCE(NEW.channel, 'broadcast'),
            json_build_object(
                'message_id', NEW.id,
                'from_agent', NEW.from_agent,
                'channel', NEW.channel
            )::text
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trig_a2a_message_notify
AFTER INSERT ON roadmap.message_ledger
FOR EACH ROW EXECUTE FUNCTION roadmap.fn_a2a_message_notify();
