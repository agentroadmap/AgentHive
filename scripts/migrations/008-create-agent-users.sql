-- 008-create-agent-users.sql
-- Description: Create per-worktree login users and grant roles
-- Date: 2026-04-07
-- Requires: schema already live (tables owned by admin)
--
-- Does NOT alter any tables or schema (no DDL).
-- Only DCL: CREATE ROLE, CREATE USER, GRANT.
--
-- Roles:
--   agent_read   — SELECT on all tables
--   agent_write  — agent_read + safe INSERT/UPDATE surfaces; no DELETE on proposals
--   admin_write  — full DML (reserved for orchestrator / migrations)
--
-- Per-worktree users:
--   agent_andy, agent_bob, agent_carter            (claude permanent team)
--   agent_claude_one                               (claude/one worktree)
--   agent_gemini_one                               (gemini/one worktree)
--   agent_copilot_one                              (copilot/one worktree)
--   agent_gilbert, agent_skeptic                   (openclaw core)
--   agent_openclaw_alpha/beta/gamma                (openclaw contract)
--   agent_xiaomi_one                               (xiaomi/one worktree)

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

GRANT CONNECT ON DATABASE agenthive TO agent_read;
GRANT USAGE ON SCHEMA public TO agent_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO agent_read;

-- ─── agent_write: safe writes ─────────────────────────────────────────────────

GRANT agent_read TO agent_write;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO agent_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO agent_write;

-- Safe full write surfaces (no critical state tables)
GRANT INSERT, UPDATE ON TABLE
    agent_registry,
    agent_memory,
    message_ledger,
    attachment_registry
TO agent_write;

-- Limited UPDATE on proposal (status/content only — no id, no owner changes)
GRANT UPDATE (
    status,
    maturity_level,
    display_id,
    title,
    body_markdown,
    tags,
    updated_at,
    assigned_to,
    assigned_at
) ON TABLE proposal TO agent_write;

-- Agents may draft new proposals
GRANT INSERT ON TABLE proposal TO agent_write;

-- Agents manage their own deps
GRANT INSERT, UPDATE, DELETE ON TABLE proposal_dependencies TO agent_write;

-- ─── admin_write: unrestricted DML ───────────────────────────────────────────

GRANT agent_write TO admin_write;
GRANT DELETE ON ALL TABLES IN SCHEMA public TO admin_write;
GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO admin_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT INSERT, UPDATE, DELETE ON TABLES TO admin_write;

-- ─── Per-agent login users ────────────────────────────────────────────────────

DO $$ BEGIN
  -- Claude permanent team
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_andy') THEN
    CREATE USER agent_andy WITH PASSWORD 'XmHPY0IlJ4MVCWsMAj8NpKUz' CONNECTION LIMIT 5;
  ELSE
    ALTER USER agent_andy WITH PASSWORD 'XmHPY0IlJ4MVCWsMAj8NpKUz';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_bob') THEN
    CREATE USER agent_bob WITH PASSWORD 'WAYjsk5ThgfF7w8tN9kVZ3cM' CONNECTION LIMIT 5;
  ELSE
    ALTER USER agent_bob WITH PASSWORD 'WAYjsk5ThgfF7w8tN9kVZ3cM';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_carter') THEN
    CREATE USER agent_carter WITH PASSWORD 'pXWJkiiMqTdQqqmV4zxZvTC' CONNECTION LIMIT 5;
  ELSE
    ALTER USER agent_carter WITH PASSWORD 'pXWJkiiMqTdQqqmV4zxZvTC';
  END IF;

  -- claude/one
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_claude_one') THEN
    CREATE USER agent_claude_one WITH PASSWORD '3yUX75DbkT1AunVv8bhU2U00' CONNECTION LIMIT 3;
  ELSE
    ALTER USER agent_claude_one WITH PASSWORD '3yUX75DbkT1AunVv8bhU2U00';
  END IF;

  -- gemini/one
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_gemini_one') THEN
    CREATE USER agent_gemini_one WITH PASSWORD '188WFzeqhDgrz9MqcyFqAgt' CONNECTION LIMIT 3;
  ELSE
    ALTER USER agent_gemini_one WITH PASSWORD '188WFzeqhDgrz9MqcyFqAgt';
  END IF;

  -- copilot/one
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_copilot_one') THEN
    CREATE USER agent_copilot_one WITH PASSWORD 'wmqMzlGGfNSBfUK77Om6y7M6' CONNECTION LIMIT 3;
  ELSE
    ALTER USER agent_copilot_one WITH PASSWORD 'wmqMzlGGfNSBfUK77Om6y7M6';
  END IF;

  -- openclaw core team
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_gilbert') THEN
    CREATE USER agent_gilbert WITH PASSWORD 'r0igdteAHFhFyrJo53gKgRK' CONNECTION LIMIT 5;
  ELSE
    ALTER USER agent_gilbert WITH PASSWORD 'r0igdteAHFhFyrJo53gKgRK';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_skeptic') THEN
    CREATE USER agent_skeptic WITH PASSWORD 'FAZo4Xvgl6HqGajZo9c8yh83' CONNECTION LIMIT 5;
  ELSE
    ALTER USER agent_skeptic WITH PASSWORD 'FAZo4Xvgl6HqGajZo9c8yh83';
  END IF;

  -- openclaw contract agents
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_openclaw_alpha') THEN
    CREATE USER agent_openclaw_alpha WITH PASSWORD 'KbEmTX50ubVhH8YnzFzu9LEj' CONNECTION LIMIT 3;
  ELSE
    ALTER USER agent_openclaw_alpha WITH PASSWORD 'KbEmTX50ubVhH8YnzFzu9LEj';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_openclaw_beta') THEN
    CREATE USER agent_openclaw_beta WITH PASSWORD 'TuVheSRczpgLhvKkYsVVUGR' CONNECTION LIMIT 3;
  ELSE
    ALTER USER agent_openclaw_beta WITH PASSWORD 'TuVheSRczpgLhvKkYsVVUGR';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_openclaw_gamma') THEN
    CREATE USER agent_openclaw_gamma WITH PASSWORD 'MYOVEm4BooHDGUg1FWONx8P5' CONNECTION LIMIT 3;
  ELSE
    ALTER USER agent_openclaw_gamma WITH PASSWORD 'MYOVEm4BooHDGUg1FWONx8P5';
  END IF;

  -- xiaomi/one
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_xiaomi_one') THEN
    CREATE USER agent_xiaomi_one WITH PASSWORD 'P26gYpUn49kObrFb3NJjORwv' CONNECTION LIMIT 3;
  ELSE
    ALTER USER agent_xiaomi_one WITH PASSWORD 'P26gYpUn49kObrFb3NJjORwv';
  END IF;
END $$;

-- ─── Grant write role to all agent users ─────────────────────────────────────

GRANT agent_write TO
    agent_andy,
    agent_bob,
    agent_carter,
    agent_claude_one,
    agent_gemini_one,
    agent_copilot_one,
    agent_gilbert,
    agent_skeptic,
    agent_openclaw_alpha,
    agent_openclaw_beta,
    agent_openclaw_gamma,
    agent_xiaomi_one;

COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- SELECT rolname, rolcanlogin, rolconnlimit
--   FROM pg_roles
--   WHERE rolname LIKE 'agent_%'
--   ORDER BY rolname;
