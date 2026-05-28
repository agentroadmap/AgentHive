-- P1408: Fix liaison-message NOTIFY channel mismatch
--
-- Root cause: fn_liaison_notify_new_message emits on 'msg_<agency_id>' (UUID payload),
-- but liaison-agent.ts:fetchMessage expects BIGINT message_id and crashes.
-- Meanwhile, liaison-message-service.ts:15 LISTENs on 'liaison_message_<agency_id>'
-- but nothing emits there.
--
-- Fix: Rename fn_liaison_notify_new_message channel from 'msg_' || agency_id
-- to 'liaison_message_' || agency_id. This way:
--   - message_ledger trigger (fn_a2a_message_notify) → msg_<to_agent> (BIGINT)
--   - liaison_message trigger (fn_liaison_notify_new_message) → liaison_message_<agency_id> (UUID)
--   - Both listeners get the right channel with correct payload types.
--
-- Codex review finding: https://github.com/AgentHive/AgentHive/discussions/7890
-- Operational evidence: 2026-05-27 06:09 offer_dispatch NOTIFY crashes

CREATE OR REPLACE FUNCTION roadmap.fn_liaison_notify_new_message()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    PERFORM pg_notify(
        'liaison_message_' || NEW.agency_id,
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
$function$;
