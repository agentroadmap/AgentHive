-- 009-roadmap-schema-grants.sql
-- Description: Grant roadmap schema access to all agent roles
-- Date: 2026-04-07
-- Requires: 008-create-agent-users.sql, roadmap schema live
--
-- Fixes: migrations 007 and 008 only grant on the public schema.
-- All production tables live in the roadmap schema.
-- Without this migration every agent user gets:
--   ERROR: permission denied for schema roadmap

BEGIN;

-- ─── agent_read: USAGE + SELECT on roadmap schema ─────────────────────────────

GRANT USAGE ON SCHEMA roadmap TO agent_read;
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap TO agent_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA roadmap TO agent_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA roadmap
  GRANT SELECT ON TABLES TO agent_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA roadmap
  GRANT SELECT ON SEQUENCES TO agent_read;

-- ─── agent_write: safe INSERT/UPDATE surfaces in roadmap schema ───────────────

GRANT USAGE ON ALL SEQUENCES IN SCHEMA roadmap TO agent_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA roadmap
  GRANT USAGE ON SEQUENCES TO agent_write;

-- Safe full-write surfaces (no critical governance tables)
GRANT INSERT, UPDATE ON TABLE
    roadmap.agent_registry,
    roadmap.agent_memory,
    roadmap.message_ledger,
    roadmap.proposal_acceptance_criteria,
    roadmap.proposal_dependencies,
    roadmap.proposal_reviews,
    roadmap.proposal_milestone,
    roadmap.proposal_discussions,
    roadmap.spending_log,
    roadmap.notification,
    roadmap.run_log
TO agent_write;

-- Agents may draft new proposals
GRANT INSERT ON TABLE roadmap.proposal TO agent_write;

-- Limited UPDATE on proposal — content fields only, no id/type/owner changes
GRANT UPDATE (
    status,
    maturity,
    title,
    summary,
    motivation,
    design,
    drawbacks,
    alternatives,
    dependency,
    priority,
    tags,
    audit,
    modified_at
) ON TABLE roadmap.proposal TO agent_write;

-- Agents manage their own dependencies
GRANT INSERT, UPDATE, DELETE ON TABLE roadmap.proposal_dependencies TO agent_write;

-- Agents write spending events
GRANT INSERT ON TABLE roadmap.spending_log TO agent_write;

-- Agents read type config and workflow tables (needed for transition validation)
GRANT SELECT ON TABLE
    roadmap.proposal_type_config,
    roadmap.workflow_templates,
    roadmap.workflow_stages,
    roadmap.workflow_transitions,
    roadmap.workflow_roles,
    roadmap.workflows,
    roadmap.proposal_valid_transitions,
    roadmap.proposal_state_transitions,
    roadmap.proposal_lease,
    roadmap.model_metadata,
    roadmap.spending_caps,
    roadmap.team,
    roadmap.team_member
TO agent_write;

-- ─── admin_write: full DML on roadmap schema ──────────────────────────────────

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA roadmap TO admin_write;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA roadmap TO admin_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA roadmap
  GRANT INSERT, UPDATE, DELETE ON TABLES TO admin_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA roadmap
  GRANT USAGE ON SEQUENCES TO admin_write;

COMMIT;

-- ─── Verification ──────────────────────────────────────────────────────────────
-- SELECT grantee, table_schema, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'roadmap'
--     AND grantee IN ('agent_read','agent_write','admin_write')
--   ORDER BY table_name, grantee, privilege_type;
