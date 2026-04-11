-- Migration 015: Knowledge Base + Directive Lifecycle + Escalation Matrix
-- Prerequisites: roadmap schema must exist (migration 002+)
-- Purpose: DDL for P061 (Knowledge Base), P078 (Directive Lifecycle), and escalation tracking.
-- Compatibility: Additive only. No changes to existing roadmap.* tables.

-- ── Knowledge Base (P061) ─────────────────────────────────────────────────────

-- knowledge_entries — persistent searchable store of reusable context fragments
CREATE TABLE IF NOT EXISTS roadmap.knowledge_entries (
  id                  text        PRIMARY KEY,
  type                text        NOT NULL CHECK (type IN ('solution','pattern','decision','obstacle','learned')),
  title               text        NOT NULL,
  content             text        NOT NULL,
  keywords            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  related_proposals   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  source_proposal_id  text,
  author              text        NOT NULL,
  confidence          int         NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  helpful_count       int         NOT NULL DEFAULT 0,
  reference_count     int         NOT NULL DEFAULT 0,
  tags                jsonb       NOT NULL DEFAULT '[]'::jsonb,
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  roadmap.knowledge_entries IS 'P061: Persistent knowledge base entries for agent collective intelligence';
COMMENT ON COLUMN roadmap.knowledge_entries.type IS 'Entry type: solution, pattern, decision, obstacle, learned';
COMMENT ON COLUMN roadmap.knowledge_entries.confidence IS 'Confidence score 0-100; used for ranking in search results';

CREATE INDEX IF NOT EXISTS idx_kb_type ON roadmap.knowledge_entries (type);
CREATE INDEX IF NOT EXISTS idx_kb_author ON roadmap.knowledge_entries (author);
CREATE INDEX IF NOT EXISTS idx_kb_confidence ON roadmap.knowledge_entries (confidence DESC);
CREATE INDEX IF NOT EXISTS idx_kb_helpful ON roadmap.knowledge_entries (helpful_count DESC);
CREATE INDEX IF NOT EXISTS idx_kb_source_proposal ON roadmap.knowledge_entries (source_proposal_id)
  WHERE source_proposal_id IS NOT NULL;

-- extracted_patterns — reusable patterns extracted from successful solutions
CREATE TABLE IF NOT EXISTS roadmap.extracted_patterns (
  id              text        PRIMARY KEY,
  name            text        NOT NULL,
  description     text        NOT NULL,
  code_example    text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  usage_count     int         NOT NULL DEFAULT 0,
  success_rate    int         NOT NULL DEFAULT 0 CHECK (success_rate BETWEEN 0 AND 100),
  related_entries jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  roadmap.extracted_patterns IS 'P061: Reusable patterns extracted from successful solutions';
COMMENT ON COLUMN roadmap.extracted_patterns.success_rate IS 'Success rate percentage 0-100 when using this pattern';

CREATE INDEX IF NOT EXISTS idx_patterns_usage ON roadmap.extracted_patterns (usage_count DESC, success_rate DESC);

-- Auto-update updated_at trigger for knowledge_entries
CREATE OR REPLACE FUNCTION fn_kb_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_kb_updated_at
  BEFORE UPDATE ON roadmap.knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION fn_kb_updated_at();

CREATE TRIGGER trg_patterns_updated_at
  BEFORE UPDATE ON roadmap.extracted_patterns
  FOR EACH ROW EXECUTE FUNCTION fn_kb_updated_at();

-- ── Escalation Log (P078) ─────────────────────────────────────────────────────

-- escalation_log — tracks obstacle escalations and their resolution
CREATE TABLE IF NOT EXISTS roadmap.escalation_log (
  id              serial      PRIMARY KEY,
  obstacle_type   text        NOT NULL CHECK (obstacle_type IN (
    'BUDGET_EXHAUSTED', 'LOOP_DETECTED', 'CYCLE_DETECTED',
    'AGENT_DEAD', 'PIPELINE_BLOCKED', 'AC_GATE_FAILED', 'DEPENDENCY_UNRESOLVED'
  )),
  proposal_id     text,
  agent_identity  text,
  escalated_to    text        NOT NULL,
  escalated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution_note text,
  severity        text        NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical'))
);

COMMENT ON TABLE  roadmap.escalation_log IS 'P078: Obstacle escalation records with resolution tracking';
COMMENT ON COLUMN roadmap.escalation_log.obstacle_type IS 'Type of obstacle that triggered escalation';
COMMENT ON COLUMN roadmap.escalation_log.escalated_to IS 'Target squad, role, or human operator for resolution';

CREATE INDEX IF NOT EXISTS idx_escalation_type ON roadmap.escalation_log (obstacle_type);
CREATE INDEX IF NOT EXISTS idx_escalation_proposal ON roadmap.escalation_log (proposal_id)
  WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_escalation_unresolved ON roadmap.escalation_log (escalated_at DESC)
  WHERE resolved_at IS NULL;

-- ── Grants ────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.knowledge_entries TO roadmap_agent;
GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.extracted_patterns TO roadmap_agent;
GRANT SELECT, INSERT, UPDATE ON roadmap.escalation_log TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.escalation_log_id_seq TO roadmap_agent;
