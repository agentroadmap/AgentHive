-- env: prod
-- P922 — Host-aware NOTIFY optimization for roadmap.liaison_message
BEGIN;

ALTER TABLE roadmap.liaison_message ADD COLUMN IF NOT EXISTS host_id text;
COMMENT ON COLUMN roadmap.liaison_message.host_id IS 'Routing field. Resolved by caller via atomic INSERT...SELECT against roadmap.agency.host_id. NULL means trigger fires per-agency only.';

UPDATE roadmap.liaison_message m SET host_id = a.host_id
  FROM roadmap.agency a
 WHERE m.agency_id = a.agency_id AND m.host_id IS NULL AND a.host_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_liaison_message_host_pending
    ON roadmap.liaison_message(host_id, created_at DESC) WHERE acked_at IS NULL;

-- Canonical channel encoder: md5 (PG built-in, NO pgcrypto)
CREATE OR REPLACE FUNCTION roadmap.fn_host_dispatch_channel(p_host_id text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'host_dispatch_' || md5(p_host_id)
$$;

-- Replace fn_liaison_notify_new_message body to dual-fire (preserve per-agency payload EXACTLY)
CREATE OR REPLACE FUNCTION roadmap.fn_liaison_notify_new_message()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        'liaison_message_' || NEW.agency_id,
        json_build_object('message_id', NEW.message_id, 'direction', NEW.direction, 'kind', NEW.kind, 'sequence', NEW.sequence)::text
    );
    IF NEW.host_id IS NOT NULL THEN
        PERFORM pg_notify(
            roadmap.fn_host_dispatch_channel(NEW.host_id),
            json_build_object('message_id', NEW.message_id, 'agency_id', NEW.agency_id, 'direction', NEW.direction, 'kind', NEW.kind, 'sequence', NEW.sequence)::text
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
