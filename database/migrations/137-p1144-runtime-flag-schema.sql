-- P1144: core.runtime_flag — runtime-tunable key/value store for orchestrator flags.
-- Operators can change poll intervals / thresholds via SQL without code edits or restarts.

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.runtime_flag (
    id               SERIAL PRIMARY KEY,
    flag_name        TEXT NOT NULL,
    scope            TEXT NOT NULL DEFAULT 'global',
    lifecycle_status TEXT NOT NULL DEFAULT 'active'
                         CHECK (lifecycle_status IN ('active', 'inactive', 'archived')),
    value_jsonb      JSONB NOT NULL,
    description      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_runtime_flag_name_scope UNIQUE (flag_name, scope)
);

CREATE INDEX IF NOT EXISTS idx_runtime_flag_active
    ON core.runtime_flag (flag_name, scope)
    WHERE lifecycle_status = 'active';

-- Auto-update updated_at on row changes.
CREATE OR REPLACE FUNCTION core.set_runtime_flag_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_runtime_flag_updated_at
    BEFORE UPDATE ON core.runtime_flag
    FOR EACH ROW
    EXECUTE FUNCTION core.set_runtime_flag_updated_at();

-- NOTIFY so config resolvers can invalidate their caches in-process.
CREATE OR REPLACE FUNCTION core.notify_runtime_flag_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'runtime_flag_changed',
        json_build_object(
            'flag_name', COALESCE(NEW.flag_name, OLD.flag_name),
            'scope',     COALESCE(NEW.scope, OLD.scope),
            'op',        TG_OP,
            'at',        now()
        )::text
    );
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_runtime_flag_changed_notify ON core.runtime_flag;
CREATE TRIGGER trg_runtime_flag_changed_notify
    AFTER INSERT OR UPDATE OR DELETE ON core.runtime_flag
    FOR EACH ROW
    EXECUTE FUNCTION core.notify_runtime_flag_changed();

COMMIT;
