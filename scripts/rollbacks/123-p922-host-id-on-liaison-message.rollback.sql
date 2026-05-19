-- Rollback for P922 — Host-aware NOTIFY optimization
BEGIN;

-- Drop the partial index
DROP INDEX IF EXISTS roadmap.idx_liaison_message_host_pending;

-- Drop the host_dispatch channel encoder function
DROP FUNCTION IF EXISTS roadmap.fn_host_dispatch_channel(text);

-- Restore single-fire trigger body
CREATE OR REPLACE FUNCTION roadmap.fn_liaison_notify_new_message()
RETURNS TRIGGER AS $$
BEGIN
    -- Notify on the agency_id channel so liaisons can listen for their own messages
    PERFORM pg_notify(
        'liaison_message_' || NEW.agency_id,
        json_build_object(
            'message_id', NEW.message_id,
            'direction', NEW.direction,
            'kind', NEW.kind,
            'sequence', NEW.sequence
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop the host_id column
ALTER TABLE roadmap.liaison_message DROP COLUMN IF EXISTS host_id;

COMMIT;
