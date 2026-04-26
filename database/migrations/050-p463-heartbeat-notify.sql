-- P463: Heartbeat NOTIFY trigger
--
-- AC#3: orchestrator updates agency.last_heartbeat_at and emits Postgres notification.
--
-- Emits on channel 'agency_heartbeat' whenever last_heartbeat_at is updated,
-- carrying agency_id and new status so orchestrator watchers can react without polling.

BEGIN;

CREATE OR REPLACE FUNCTION roadmap.fn_agency_heartbeat_notify()
RETURNS TRIGGER AS $$
BEGIN
    -- Only fire when last_heartbeat_at actually changed
    IF NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at THEN
        PERFORM pg_notify(
            'agency_heartbeat',
            json_build_object(
                'agency_id',        NEW.agency_id,
                'status',           NEW.status,
                'heartbeat_at',     NEW.last_heartbeat_at
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trig_agency_heartbeat_notify ON roadmap.agency;
CREATE TRIGGER trig_agency_heartbeat_notify
    AFTER UPDATE ON roadmap.agency
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_agency_heartbeat_notify();

COMMIT;
