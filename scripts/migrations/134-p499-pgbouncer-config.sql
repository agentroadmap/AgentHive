-- Migration 134: P499 PgBouncer config registry defaults
-- Seeds roadmap.app_config with the PgBouncer port routing defaults so
-- operators can inspect them via config_audit and override per-environment.
--
-- AGENTHIVE_PG_PORT    = PgBouncer listen port (query clients use this, default 6432)
-- AGENTHIVE_LISTEN_PORT = Direct Postgres port (LISTEN-only bypass, default 5432)
-- PGPORT_DIRECT         = Alias for AGENTHIVE_LISTEN_PORT
--
-- Authoritative runtime values live in /etc/agenthive/env; these records are
-- documentation / operator visibility only.

BEGIN;

INSERT INTO roadmap.app_config (config_key, config_value, config_category, description)
VALUES
  (
    'AGENTHIVE_PG_PORT',
    '"6432"',
    'infrastructure',
    'PgBouncer listen port (P499). Query clients connect here for transaction-mode pooling. Override with env var of same name.'
  ),
  (
    'AGENTHIVE_LISTEN_PORT',
    '"5432"',
    'infrastructure',
    'Direct Postgres port for LISTEN-only connections (P499 Option A bypass). Bypasses PgBouncer. See pool-registry.ts, config.ts, feature-flag-service.ts.'
  ),
  (
    'PGPORT_DIRECT',
    '"5432"',
    'infrastructure',
    'Alias for AGENTHIVE_LISTEN_PORT. Direct Postgres port bypassing PgBouncer. Used by LISTEN clients (pool_evict, runtime_config_changed, feature_flag_changed channels).'
  )
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
