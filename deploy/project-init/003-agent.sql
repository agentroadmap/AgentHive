-- ============================================================
-- project-init/003-agent.sql
-- Agent tables: agent (root), aLease, aSkill, aTrust, aHeartbeat.
-- Run with: psql -v schema_name=agentHive -f 003-agent.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- agent — registered agents for this project
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.agent (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL UNIQUE,          -- 'claude-dev-1', 'codex-review-2', etc.
  display_name     TEXT         NOT NULL,
  provider_slug    TEXT         NOT NULL,                 -- soft FK to agency.provider.slug
  model_id         TEXT,                                  -- soft FK to agency.model.model_id
  kind             TEXT         NOT NULL DEFAULT 'developer'
                               CHECK (kind IN ('developer','reviewer','gate-reviewer','orchestrator','observer')),
  did              TEXT,                                  -- soft FK to identity.principal.did
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_kind_active ON :schema_name.agent (kind)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_agent
  BEFORE UPDATE ON :schema_name.agent
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.agent IS
  'Agents registered for this project. provider_slug and model_id are soft FKs to the agency schema.';

-- ============================================================
-- aLease — proposal leases (one active lease per proposal)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.aLease (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  agent_slug       TEXT         NOT NULL,
  claimed_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ  NOT NULL,
  released_at      TIMESTAMPTZ,
  release_reason   TEXT,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS alease_active_one_per_proposal
  ON :schema_name.aLease (proposal_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS alease_agent ON :schema_name.aLease (agent_slug);
CREATE INDEX IF NOT EXISTS alease_expires ON :schema_name.aLease (expires_at)
  WHERE released_at IS NULL;

COMMENT ON TABLE :schema_name.aLease IS
  'Proposal leases. At most one active (released_at IS NULL) lease per proposal enforced by partial unique index.';

-- ============================================================
-- aSkill — agent skills / capabilities for this project
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.aSkill (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id         BIGINT       NOT NULL REFERENCES :schema_name.agent (id) ON DELETE CASCADE,
  skill            TEXT         NOT NULL,                 -- 'typescript', 'postgres', 'gate-review', etc.
  proficiency      TEXT         NOT NULL DEFAULT 'capable'
                               CHECK (proficiency IN ('learning','capable','expert')),
  granted_by       TEXT,
  granted_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  notes            TEXT,
  UNIQUE (agent_id, skill)
);

CREATE INDEX IF NOT EXISTS askill_skill ON :schema_name.aSkill (skill);

COMMENT ON TABLE :schema_name.aSkill IS
  'Agent skill declarations per project. skill values are free-form; gate-review is a sentinel for gate eligibility.';

-- ============================================================
-- aTrust — per-project agent trust levels
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.aTrust (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id         BIGINT       NOT NULL REFERENCES :schema_name.agent (id) ON DELETE CASCADE,
  trust_level      TEXT         NOT NULL DEFAULT 'standard'
                               CHECK (trust_level IN ('restricted','standard','trusted','elevated')),
  granted_by       TEXT         NOT NULL,
  granted_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  reason           TEXT
);

CREATE INDEX IF NOT EXISTS atrust_agent ON :schema_name.aTrust (agent_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE :schema_name.aTrust IS
  'Trust levels granted to agents within this project. Revoked trust has revoked_at set.';

-- ============================================================
-- aHeartbeat — agent liveness signals
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.aHeartbeat (
  agent_slug       TEXT         PRIMARY KEY,
  last_beat_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status           TEXT         NOT NULL DEFAULT 'active'
                               CHECK (status IN ('starting','active','idle','stopped')),
  current_lease_id BIGINT       REFERENCES :schema_name.aLease (id) ON DELETE SET NULL,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS aheartbeat_recent ON :schema_name.aHeartbeat (last_beat_at);

COMMENT ON TABLE :schema_name.aHeartbeat IS
  'Agent liveness. Upserted by each agent. No lifecycle columns — rows are replaced, not deprecated.';
