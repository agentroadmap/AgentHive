-- ============================================================
-- project-init/000-schema.sql
-- Creates the per-project schema and shared trigger function.
-- Run with: psql -v schema_name=agentHive -f 000-schema.sql
-- ============================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS :schema_name;

-- Shared updated_at trigger (schema-local copy so it's self-contained)
CREATE OR REPLACE FUNCTION :schema_name.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

COMMENT ON SCHEMA :schema_name IS
  'Per-project schema for AgentHive project. Contains proposals, workflow, '
  'agents, messaging, spending, and knowledge-base tables.';
