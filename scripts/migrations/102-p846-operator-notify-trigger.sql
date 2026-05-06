-- Migration 102: P846 — pg_notify trigger for system:operator channel messages

BEGIN;

-- Notify operator SSE relay when a message is sent to system:operator channel.
-- Fires on the same 'a2a_msg_operator' channel used by DM messages (migration 100),
-- so Part 3's LISTEN receives both DMs (to_agent='operator') and channel messages.
CREATE OR REPLACE FUNCTION roadmap.notify_operator_message()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.channel = 'system:operator' THEN
    PERFORM pg_notify(
      'a2a_msg_operator',
      json_build_object(
        'type', 'message',
        'from', NEW.from_agent,
        'channel', NEW.channel,
        'body', NEW.message_content,
        'ts', NEW.created_at::text
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- trig_a2a_message_notify is already taken by migration 100. Use unique name.
DROP TRIGGER IF EXISTS trig_operator_message_notify ON roadmap.message_ledger;
CREATE TRIGGER trig_operator_message_notify
  AFTER INSERT ON roadmap.message_ledger
  FOR EACH ROW EXECUTE FUNCTION roadmap.notify_operator_message();

-- mentions trigger: send_mention inserts into roadmap.mentions but fires no pg_notify.
-- Add it here so mentions to the operator are also delivered.
CREATE OR REPLACE FUNCTION roadmap.notify_mention_agent()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'agent_msg_' || NEW.mentioned_agent,
    json_build_object(
      'type', 'mention',
      'from', NEW.mentioned_by,
      'context', NEW.context,
      'ts', NOW()::text
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_mention ON roadmap.mentions;
CREATE TRIGGER trg_notify_mention
  AFTER INSERT ON roadmap.mentions
  FOR EACH ROW EXECUTE FUNCTION roadmap.notify_mention_agent();

COMMIT;
