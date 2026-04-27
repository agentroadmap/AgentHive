-- ============================================================
-- P592 — hiveCentral role bootstrap
-- Creates the per-service Postgres roles referenced by §9 of the redesign.
-- Idempotent: ALTER if already present.
-- Run BEFORE any schema DDL.
-- ============================================================
-- Required runtime settings (passed via PGOPTIONS GUC custom parameters):
--   PGOPTIONS='-c agenthive.admin_password=<vault value> \
--              -c agenthive.orchestrator_password=<vault value> \
--              -c agenthive.agency_password=<vault value> \
--              -c agenthive.a2a_password=<vault value> \
--              -c agenthive.observability_password=<vault value> \
--              -c agenthive.repl_password=<vault value>'
-- NOTE: Do NOT use psql -v foo=bar — that sets client substitution variable :foo,
--       not the GUC agenthive.foo used by current_setting(). Use PGOPTIONS= instead.
-- ============================================================

\set ON_ERROR_STOP on

-- agenthive_admin — SUPERUSER, only for migrations and DBA work
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_admin') THEN
    EXECUTE format('CREATE ROLE agenthive_admin WITH LOGIN SUPERUSER PASSWORD %L',
                   current_setting('agenthive.admin_password'));
  ELSE
    EXECUTE format('ALTER ROLE agenthive_admin WITH PASSWORD %L',
                   current_setting('agenthive.admin_password'));
  END IF;
END $$;

-- agenthive_orchestrator — central dispatch service
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    EXECUTE format('CREATE ROLE agenthive_orchestrator WITH LOGIN PASSWORD %L NOSUPERUSER',
                   current_setting('agenthive.orchestrator_password'));
  ELSE
    EXECUTE format('ALTER ROLE agenthive_orchestrator WITH PASSWORD %L',
                   current_setting('agenthive.orchestrator_password'));
  END IF;
END $$;

-- agenthive_agency — per-agency service worker
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    EXECUTE format('CREATE ROLE agenthive_agency WITH LOGIN PASSWORD %L NOSUPERUSER',
                   current_setting('agenthive.agency_password'));
  ELSE
    EXECUTE format('ALTER ROLE agenthive_agency WITH PASSWORD %L',
                   current_setting('agenthive.agency_password'));
  END IF;
END $$;

-- agenthive_a2a — message bus consumer/producer
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_a2a') THEN
    EXECUTE format('CREATE ROLE agenthive_a2a WITH LOGIN PASSWORD %L NOSUPERUSER',
                   current_setting('agenthive.a2a_password'));
  ELSE
    EXECUTE format('ALTER ROLE agenthive_a2a WITH PASSWORD %L',
                   current_setting('agenthive.a2a_password'));
  END IF;
END $$;

-- agenthive_observability — read-only across most schemas; write to observability rollups
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    EXECUTE format('CREATE ROLE agenthive_observability WITH LOGIN PASSWORD %L NOSUPERUSER',
                   current_setting('agenthive.observability_password'));
  ELSE
    EXECUTE format('ALTER ROLE agenthive_observability WITH PASSWORD %L',
                   current_setting('agenthive.observability_password'));
  END IF;
END $$;

-- agenthive_repl — REPLICATION role for streaming/logical replication
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_repl') THEN
    EXECUTE format('CREATE ROLE agenthive_repl WITH LOGIN REPLICATION PASSWORD %L',
                   current_setting('agenthive.repl_password'));
  ELSE
    EXECUTE format('ALTER ROLE agenthive_repl WITH PASSWORD %L',
                   current_setting('agenthive.repl_password'));
  END IF;
END $$;

-- Per-tenant roles (agenthive_tenant_<slug>) are created by the Tenant Lifecycle
-- Control provisioning flow (P601), not here.

\echo 'hiveCentral roles bootstrapped.'
SELECT rolname, rolsuper, rolreplication
  FROM pg_roles
 WHERE rolname LIKE 'agenthive_%'
 ORDER BY rolname;
