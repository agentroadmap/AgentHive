-- ============================================================
-- agentHive2 — 000-roles.sql
-- Creates all Postgres roles for agentHive2.
-- Run as superuser BEFORE any other system-init file.
-- Safe to re-run (idempotent).
-- ============================================================
-- Roles:
--   agenthive_admin         — superuser, owns all schemas/tables
--   agenthive_orchestrator  — read/write control plane + all project schemas
--   agenthive_agency        — agencies: read config, write heartbeats/sessions
--   agenthive_a2a           — agent-to-agent messaging
--   agenthive_observability — read-only across all schemas
--   agenthive_repl          — streaming replication
-- ============================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  admin_pw text := current_setting('agenthive.admin_password', true);
BEGIN
  -- agenthive_admin (superuser / owner)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_admin') THEN
    EXECUTE format(
      'CREATE ROLE agenthive_admin LOGIN SUPERUSER CREATEROLE CREATEDB REPLICATION PASSWORD %L',
      COALESCE(NULLIF(admin_pw, ''), 'changeme')
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE agenthive_admin LOGIN SUPERUSER CREATEROLE CREATEDB REPLICATION',
      COALESCE(NULLIF(admin_pw, ''), 'changeme')
    );
  END IF;

  -- agenthive_orchestrator
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    CREATE ROLE agenthive_orchestrator LOGIN;
  END IF;

  -- agenthive_agency
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    CREATE ROLE agenthive_agency LOGIN;
  END IF;

  -- agenthive_a2a
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_a2a') THEN
    CREATE ROLE agenthive_a2a LOGIN;
  END IF;

  -- agenthive_observability (read-only)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    CREATE ROLE agenthive_observability LOGIN;
  END IF;

  -- agenthive_repl (streaming replication)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_repl') THEN
    CREATE ROLE agenthive_repl LOGIN REPLICATION;
  END IF;
END $$;
