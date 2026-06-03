-- P230: Layered Memory System
-- team_memory, context_packages, memory_access_log tables,
-- importance_score on agent_memory, and context invalidation triggers.
-- Applied directly; recorded here for migration-history tracking.

-- 1. team_memory — shared squad decisions (no team_name column in agent_memory)
CREATE TABLE IF NOT EXISTS roadmap_efficiency.team_memory (
    id           BIGSERIAL PRIMARY KEY,
    team_name    TEXT NOT NULL,
    memory_key   TEXT NOT NULL,
    memory_value JSONB NOT NULL,
    created_by   TEXT NOT NULL,
    expires_at   TIMESTAMPTZ,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_name, memory_key)
);
CREATE INDEX IF NOT EXISTS idx_team_memory_team ON roadmap_efficiency.team_memory (team_name);
CREATE INDEX IF NOT EXISTS idx_team_memory_expires ON roadmap_efficiency.team_memory (expires_at)
  WHERE expires_at IS NOT NULL;

-- 2. context_packages — proposal-scoped context cache
CREATE TABLE IF NOT EXISTS roadmap_efficiency.context_packages (
    id           BIGSERIAL PRIMARY KEY,
    proposal_id  BIGINT NOT NULL,
    package_type TEXT NOT NULL
      CHECK (package_type IN ('gate_review','code_gen','research','review','test_writing')),
    context_text TEXT NOT NULL,
    token_count  INTEGER,
    hit_count    INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ,
    UNIQUE (proposal_id, package_type)
);
CREATE INDEX IF NOT EXISTS idx_ctx_pkg_proposal ON roadmap_efficiency.context_packages (proposal_id);
CREATE INDEX IF NOT EXISTS idx_ctx_pkg_expires  ON roadmap_efficiency.context_packages (expires_at)
  WHERE expires_at IS NOT NULL;

-- 3. importance_score on existing agent_memory
ALTER TABLE roadmap_efficiency.agent_memory
  ADD COLUMN IF NOT EXISTS importance_score SMALLINT NOT NULL DEFAULT 5
    CHECK (importance_score BETWEEN 1 AND 10);

-- 4. memory_access_log — append-only analytics
CREATE TABLE IF NOT EXISTS roadmap_efficiency.memory_access_log (
    id             BIGSERIAL PRIMARY KEY,
    agent_identity TEXT,
    memory_table   TEXT NOT NULL
      CHECK (memory_table IN ('team_memory','agent_memory','context_packages')),
    memory_id      BIGINT NOT NULL,
    access_type    TEXT NOT NULL CHECK (access_type IN ('read','write','invalidate')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Context invalidation trigger on proposal status change
CREATE OR REPLACE FUNCTION roadmap.fn_invalidate_context_on_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM roadmap_efficiency.context_packages WHERE proposal_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invalidate_context_pkg ON roadmap_proposal.proposal;
CREATE TRIGGER trg_invalidate_context_pkg
  AFTER UPDATE OF status ON roadmap_proposal.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_invalidate_context_on_status_change();

-- 6. Context invalidation trigger on acceptance_criteria status change
CREATE OR REPLACE FUNCTION roadmap.fn_invalidate_context_on_ac_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM roadmap_efficiency.context_packages WHERE proposal_id = NEW.proposal_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invalidate_context_pkg_on_ac ON roadmap_proposal.proposal_acceptance_criteria;
CREATE TRIGGER trg_invalidate_context_pkg_on_ac
  AFTER UPDATE OF status ON roadmap_proposal.proposal_acceptance_criteria
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_invalidate_context_on_ac_change();
