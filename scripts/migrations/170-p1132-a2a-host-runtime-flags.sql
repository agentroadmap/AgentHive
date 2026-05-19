-- P1132: core.runtime_flag table + seed A2A host service tunables.
--
-- Why this migration creates the table:
--   src/shared/runtime/config-keys.ts references `core.runtime_flag` as the
--   canonical FlagKeys table, but the table doesn't exist on disk today.
--   The resolver's getDbValue() at src/shared/runtime/config.ts:516 also has
--   a bug (SELECT ... LIMIT 1 without WHERE) so the universal-config FlagKeys
--   path is partially aspirational. This migration creates the table so future
--   resolver fixes have something to query; for now, start-a2a-host.ts queries
--   it directly via `SELECT value_jsonb FROM core.runtime_flag WHERE name=$1`.
--
-- Schema mirrors what config-keys.ts comments imply:
--   - name TEXT PRIMARY KEY (flag name, matches ConfigKey.name)
--   - value_jsonb JSONB NOT NULL (typed value via JSON; integers stored as JSON numbers)
--   - description TEXT (operator-facing, optional)
--   - updated_at TIMESTAMPTZ (audit trail)
--
-- Trigger fires `runtime_config_changed` NOTIFY on any change so live consumers
-- (config.ts's notifySubscription, or direct LISTEN clients in services) can
-- invalidate their caches without a restart.

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.runtime_flag (
  name         TEXT PRIMARY KEY,
  value_jsonb  JSONB NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.runtime_flag IS
  'Operator-tunable runtime values. Source of truth for FlagKeys in src/shared/runtime/config-keys.ts. Live-reload via runtime_config_changed NOTIFY.';

-- ─── NOTIFY trigger ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION core.fn_runtime_flag_notify() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_name TEXT;
BEGIN
  v_name := COALESCE(NEW.name, OLD.name);
  PERFORM pg_notify(
    'runtime_config_changed',
    json_build_object(
      'name', v_name,
      'op',   TG_OP,
      'at',   to_jsonb(now())
    )::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS trg_runtime_flag_notify ON core.runtime_flag;
CREATE TRIGGER trg_runtime_flag_notify
AFTER INSERT OR UPDATE OR DELETE ON core.runtime_flag
FOR EACH ROW EXECUTE FUNCTION core.fn_runtime_flag_notify();

-- ─── A2A host service tunables (seed) ───────────────────────────────────────
INSERT INTO core.runtime_flag (name, value_jsonb, description) VALUES
  ('A2A_HOST_LISTEN_REFRESH_MS',
   '60000'::jsonb,
   'How often A2A re-reads agent_registry for newly-registered local agencies (ms)'),
  ('A2A_HOST_PG_RECONNECT_MS',
   '5000'::jsonb,
   'Backoff on PG connection loss before exit(1) (ms)'),
  ('A2A_HOST_SHUTDOWN_TIMEOUT_MS',
   '5000'::jsonb,
   'Bounded wait for fn_pulse(offline) calls during SIGTERM (ms)'),
  ('A2A_HOST_PRESENCE_REFRESH_MS',
   '30000'::jsonb,
   'How often A2A calls fn_pulse(''online'') per child to keep last_heartbeat_at fresh for existing dispatchability/maintenance consumers (ms)')
ON CONFLICT (name) DO NOTHING;

COMMIT;
