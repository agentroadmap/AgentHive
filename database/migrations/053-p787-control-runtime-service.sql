-- P787: DB-backed runtime endpoint registry for MCP/daemon resolution.

BEGIN;

CREATE SCHEMA IF NOT EXISTS roadmap;

CREATE TABLE IF NOT EXISTS roadmap.control_runtime_service (
    service_key      text PRIMARY KEY,
    url              text NOT NULL CHECK (btrim(url) <> ''),
    description      text,
    lifecycle_status text NOT NULL DEFAULT 'active'
        CHECK (lifecycle_status IN ('active', 'deprecated', 'retired', 'blocked')),
    metadata         jsonb NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_control_runtime_service_active
    ON roadmap.control_runtime_service (service_key)
    WHERE lifecycle_status = 'active';

CREATE OR REPLACE FUNCTION roadmap.set_control_runtime_service_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER set_updated_at_control_runtime_service
    BEFORE UPDATE ON roadmap.control_runtime_service
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.set_control_runtime_service_updated_at();

CREATE OR REPLACE FUNCTION roadmap.notify_runtime_endpoint_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'runtime_endpoint_changed',
        json_build_object(
            'service_key', COALESCE(NEW.service_key, OLD.service_key),
            'op', TG_OP
        )::text
    );
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS runtime_endpoint_changed_notify ON roadmap.control_runtime_service;
CREATE TRIGGER runtime_endpoint_changed_notify
    AFTER INSERT OR UPDATE OR DELETE ON roadmap.control_runtime_service
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.notify_runtime_endpoint_changed();

INSERT INTO roadmap.control_runtime_service (service_key, url, description)
VALUES
    ('mcp', 'http://127.0.0.1:6421/sse', 'Default AgentHive MCP SSE endpoint'),
    ('daemon', 'http://127.0.0.1:6420', 'Default AgentHive daemon endpoint')
ON CONFLICT (service_key) DO NOTHING;

COMMIT;
