-- 097: P149 Phase C — Liaison messages route through message_ledger
--
-- Makes message_ledger the single source of truth for all A2A traffic.
-- liaison_message becomes an ack-status side table with a FK to message_ledger.id.
-- Existing liaison rows are backward-compatible (ledger_id nullable → NULL for old rows).

-- 1. Add metadata column to message_ledger for HMAC signature and liaison protocol fields
ALTER TABLE roadmap.message_ledger
    ADD COLUMN IF NOT EXISTS metadata jsonb;

-- 2. Extend channel constraint: allow system:liaison:<agency_id> in addition to existing formats
--    Old: '^(direct|team:.+|broadcast|system)$'
--    New: '^(direct|team:.+|broadcast|system(:.+)?)$'
ALTER TABLE roadmap.message_ledger
    DROP CONSTRAINT IF EXISTS message_ledger_channel_check;
ALTER TABLE roadmap.message_ledger
    ADD CONSTRAINT message_ledger_channel_check
    CHECK ((channel IS NULL) OR (channel ~ '^(direct|team:.+|broadcast|system(:.+)?)$'));

-- 3. Add 'liaison' to allowed message_type values
ALTER TABLE roadmap.message_ledger
    DROP CONSTRAINT IF EXISTS message_ledger_type_check;
ALTER TABLE roadmap.message_ledger
    ADD CONSTRAINT message_ledger_type_check
    CHECK (message_type = ANY (ARRAY[
        'text'::text, 'task'::text, 'notify'::text,
        'ack'::text, 'error'::text, 'event'::text, 'liaison'::text
    ]));

-- 4. Add ledger_id FK to liaison_message (nullable — old rows remain NULL)
ALTER TABLE roadmap.liaison_message
    ADD COLUMN IF NOT EXISTS ledger_id bigint
    REFERENCES roadmap.message_ledger(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_liaison_message_ledger_id
    ON roadmap.liaison_message (ledger_id)
    WHERE ledger_id IS NOT NULL;

-- 5. Extend fn_a2a_message_notify to also fire on system:liaison:* channels.
--    This allows future consumers to LISTEN on a2a_chan_system:liaison:<agency_id>
--    instead of the liaison-specific liaison_message_<agency_id> channel.
--    The existing liaison LISTEN/NOTIFY (trig_liaison_notify_new_message on liaison_message)
--    remains unchanged — this is additive.
CREATE OR REPLACE FUNCTION roadmap.fn_a2a_message_notify()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
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
    IF NEW.channel LIKE 'team:%' THEN
        PERFORM pg_notify(
            'a2a_chan_' || NEW.channel,
            json_build_object(
                'message_id', NEW.id,
                'from_agent', NEW.from_agent
            )::text
        );
    END IF;
    IF NEW.channel LIKE 'system:liaison:%' THEN
        PERFORM pg_notify(
            'a2a_chan_' || NEW.channel,
            json_build_object(
                'message_id', NEW.id,
                'from_agent', NEW.from_agent,
                'metadata', NEW.metadata
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$;
