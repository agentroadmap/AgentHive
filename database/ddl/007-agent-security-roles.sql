-- 007-agent-security-roles.sql
-- Description: Postgres security isolation for agent types
-- Date: 2026-04-06
-- Requires: 006-autonomous-pipeline.sql
--
-- Creates three roles:
--   agent_read       — SELECT on all tables; used by read-only observers
--   agent_write      — agent_read + INSERT/UPDATE on safe tables; NO DELETE on proposals
--   admin_write      — full DML; reserved for orchestrator / migration tooling
--
-- Per-agent DB users follow the naming convention:
--   agent_<name>    e.g.  agent_andy, agent_gemini_one, agent_openclaw_alpha
-- Each user is GRANTED agent_write (or agent_read for passive agents).
--
-- Destructive operations (DELETE on proposals, TRUNCATE, DROP) require
-- explicit USER approval via the MCP destructive-op gate — they are NOT
-- granted to agent_write at the DB level at all.

BEGIN;

-- ─── Base roles ───────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_read') THEN
    CREATE ROLE agent_read NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_write') THEN
    CREATE ROLE agent_write NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_write') THEN
    CREATE ROLE admin_write NOLOGIN;
  END IF;
END $$;

-- ─── agent_read: SELECT everywhere ───────────────────────────────────────────

GRANT CONNECT ON DATABASE agentdemo TO agent_read;
GRANT USAGE ON SCHEMA public TO agent_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO agent_read;

-- ─── agent_write: safe writes — no DELETE on core tables ─────────────────────

GRANT agent_read TO agent_write;

-- Sequences needed for INSERT (IDENTITY columns)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO agent_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO agent_write;

-- Allowed write surfaces
GRANT INSERT, UPDATE ON TABLE
    agent_registry,
    message_ledger,
    agent_runs,
    research_cache,
    decision_queue,
    transition_queue,
    agent_budget_ledger,
    agent_conflicts,
    notification_queue
TO agent_write;

-- Limited UPDATE on proposals (status, maturity — no delete, no id change)
GRANT UPDATE (
    status,
    maturity_level,
    display_id,
    title,
    description,
    updated_at
) ON TABLE proposal TO agent_write;

-- Allow INSERT for new proposals (agents may draft)
GRANT INSERT ON TABLE proposal TO agent_write;

-- Full write on proposal_dependencies (agents manage their own deps)
GRANT INSERT, UPDATE, DELETE ON TABLE proposal_dependencies TO agent_write;

-- ─── admin_write: unrestricted DML ───────────────────────────────────────────

GRANT agent_write TO admin_write;
GRANT DELETE ON ALL TABLES IN SCHEMA public TO admin_write;
GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO admin_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT INSERT, UPDATE, DELETE ON TABLES TO admin_write;

-- ─── Per-agent login users (Claude permanent team) ───────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_andy') THEN
    CREATE USER agent_andy WITH PASSWORD 'CHANGE_ME_andy' CONNECTION LIMIT 5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_bob') THEN
    CREATE USER agent_bob WITH PASSWORD 'CHANGE_ME_bob' CONNECTION LIMIT 5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_carter') THEN
    CREATE USER agent_carter WITH PASSWORD 'CHANGE_ME_carter' CONNECTION LIMIT 5;
  END IF;
END $$;

GRANT agent_write TO agent_andy, agent_bob, agent_carter;

-- ─── Per-agent login users (Gemini) ──────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_gemini_one') THEN
    CREATE USER agent_gemini_one WITH PASSWORD 'CHANGE_ME_gemini' CONNECTION LIMIT 3;
  END IF;
END $$;

GRANT agent_write TO agent_gemini_one;

-- ─── Per-agent login users (Copilot) ─────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_copilot_one') THEN
    CREATE USER agent_copilot_one WITH PASSWORD 'CHANGE_ME_copilot' CONNECTION LIMIT 3;
  END IF;
END $$;

GRANT agent_write TO agent_copilot_one;

-- ─── Per-agent login users (OpenClaw) ────────────────────────────────────────
-- Core team: Gilbert (git merger), Skeptic (critic)
-- Contract agents: alpha, beta, gamma

DO $$ BEGIN
  -- Core team (permanent)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_gilbert') THEN
    CREATE USER agent_gilbert WITH PASSWORD 'CHANGE_ME_gilbert' CONNECTION LIMIT 5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_skeptic') THEN
    CREATE USER agent_skeptic WITH PASSWORD 'CHANGE_ME_skeptic' CONNECTION LIMIT 5;
  END IF;
  -- Contract agents
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_openclaw_alpha') THEN
    CREATE USER agent_openclaw_alpha WITH PASSWORD 'CHANGE_ME_alpha' CONNECTION LIMIT 3;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_openclaw_beta') THEN
    CREATE USER agent_openclaw_beta WITH PASSWORD 'CHANGE_ME_beta' CONNECTION LIMIT 3;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_openclaw_gamma') THEN
    CREATE USER agent_openclaw_gamma WITH PASSWORD 'CHANGE_ME_gamma' CONNECTION LIMIT 3;
  END IF;
END $$;

GRANT agent_write TO agent_gilbert, agent_skeptic;
GRANT agent_write TO agent_openclaw_alpha, agent_openclaw_beta, agent_openclaw_gamma;

-- ─── Row-level security (future gate) ────────────────────────────────────────
-- Enable RLS on message_ledger so agents can only read their own messages.
-- Activate by: ALTER TABLE message_ledger ENABLE ROW LEVEL SECURITY;
-- Then add policies per agent:
--   CREATE POLICY msg_own ON message_ledger
--     USING (from_agent = current_user OR to_agent = current_user);
--
-- Not enabled by default — requires app-level testing first.

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- SELECT grantee, privilege_type, table_name
--   FROM information_schema.role_table_grants
--   WHERE grantee IN ('agent_read','agent_write','admin_write')
--   ORDER BY table_name, grantee, privilege_type;
