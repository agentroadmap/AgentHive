-- P230: Layered Memory System — team memory, context packages, importance scoring
--
-- Net-new additions only (does NOT redefine existing agent_memory):
--   1. ADD COLUMN importance_score to roadmap_efficiency.agent_memory
--   2. roadmap_efficiency.team_memory           — squad-shared decisions/knowledge
--   3. roadmap_efficiency.context_packages      — proposal-scoped context cache
--   4. roadmap_efficiency.memory_access_log     — append-only analytics
--   5. Immediate-invalidation triggers on proposal status + AC status changes

BEGIN;

-- ─── 1. importance_score on existing agent_memory ─────────────────────────────

ALTER TABLE roadmap_efficiency.agent_memory
  ADD COLUMN IF NOT EXISTS importance_score smallint NOT NULL DEFAULT 5
    CHECK (importance_score BETWEEN 1 AND 10);

COMMENT ON COLUMN roadmap_efficiency.agent_memory.importance_score IS
'Decay priority 1 (evict first) … 10 (keep longest). Defaults to 5.';

-- ─── 2. team_memory ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_efficiency.team_memory (
    id           BIGSERIAL    PRIMARY KEY,
    team_name    TEXT         NOT NULL,
    memory_key   TEXT         NOT NULL,
    memory_value JSONB        NOT NULL,
    created_by   TEXT         NOT NULL,
    expires_at   TIMESTAMPTZ,
    access_count INTEGER      NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (team_name, memory_key)
);

COMMENT ON TABLE roadmap_efficiency.team_memory IS
'Shared squad-level decisions and durable knowledge. All squad members can read; '
'any member can write (last-write wins on the unique key). Distinct from agent_memory '
'because the query access pattern is team-name-scoped, not agent-identity-scoped.';

CREATE INDEX IF NOT EXISTS idx_team_memory_team
  ON roadmap_efficiency.team_memory (team_name);

CREATE INDEX IF NOT EXISTS idx_team_memory_expires
  ON roadmap_efficiency.team_memory (expires_at)
  WHERE expires_at IS NOT NULL;

-- ─── 3. context_packages ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_efficiency.context_packages (
    id           BIGSERIAL    PRIMARY KEY,
    proposal_id  BIGINT       NOT NULL,
    package_type TEXT         NOT NULL
        CHECK (package_type IN ('gate_review','code_gen','research','review','test_writing')),
    context_text TEXT         NOT NULL,
    token_count  INTEGER,
    hit_count    INTEGER      NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ,
    UNIQUE (proposal_id, package_type)
);

COMMENT ON TABLE roadmap_efficiency.context_packages IS
'Per-proposal context cache. One row per (proposal, package_type). '
'Invalidated immediately when the proposal status or any of its ACs changes status. '
'Saves ~500 tokens/dispatch vs dumping full CLAUDE.md on every spawn.';

CREATE INDEX IF NOT EXISTS idx_ctx_pkg_proposal
  ON roadmap_efficiency.context_packages (proposal_id);

CREATE INDEX IF NOT EXISTS idx_ctx_pkg_expires
  ON roadmap_efficiency.context_packages (expires_at)
  WHERE expires_at IS NOT NULL;

-- ─── 4. memory_access_log ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_efficiency.memory_access_log (
    id             BIGSERIAL    PRIMARY KEY,
    agent_identity TEXT,
    memory_table   TEXT         NOT NULL
        CHECK (memory_table IN ('team_memory','agent_memory','context_packages')),
    memory_id      BIGINT       NOT NULL,
    access_type    TEXT         NOT NULL
        CHECK (access_type IN ('read','write','invalidate')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_efficiency.memory_access_log IS
'Append-only analytics for memory access patterns. Low-priority; never blocks ops.';

-- ─── 5a. Invalidation trigger — proposal status change ────────────────────────

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

-- ─── 5b. Invalidation trigger — acceptance_criteria status change ─────────────

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

COMMIT;
