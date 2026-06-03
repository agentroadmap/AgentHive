-- ============================================================
-- Migration 149 — P901 Phase 1: template.workflow_template_alias
-- ============================================================
-- Creates the alias table (Finding 10: was never DDL-materialised)
-- and seeds the two canonical alias rows so that project-init and
-- orchestrator bootstrap code can resolve by alias name rather
-- than hardcoding a versioned template_id string.
--
-- Target DB: agenthive (v1) — the template schema is live via migration 070.
-- hiveCentral DDL (007 approach, BIGINT PK) is tracked separately.
--
-- Rollback: DROP TABLE IF EXISTS template.workflow_template_alias CASCADE;
--           (additive only — no existing rows or FKs depend on this table)
-- ============================================================

BEGIN;

-- ── 1. workflow_template_alias table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS template.workflow_template_alias (
  alias_name       TEXT        PRIMARY KEY,
  template_id      TEXT        NOT NULL
                               REFERENCES template.workflow_template(template_id)
                               ON UPDATE CASCADE ON DELETE RESTRICT,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wt_alias_template_id
  ON template.workflow_template_alias (template_id);

COMMENT ON TABLE template.workflow_template_alias IS
  'Stable alias names resolving to a specific template_id. '
  'Example: alias_name=''default'' → template_id=''rfc-5-stage@v1''. '
  'Written once at seed time; updated only when the platform default changes. '
  'Consumed by template-catalog.ts:resolveTemplateAlias() (P901 Finding 17).';

COMMENT ON COLUMN template.workflow_template_alias.alias_name IS
  'Short stable name: ''default'', ''hotfix'', ''lightweight''. snake_case only.';

COMMENT ON COLUMN template.workflow_template_alias.template_id IS
  'Target template. ON UPDATE CASCADE propagates if template_id is corrected.';

-- ── 2. Seed: canonical aliases for seeded templates (migration 070) ───────────
-- ON CONFLICT DO NOTHING: safe to re-run; existing aliases are not mutated.

INSERT INTO template.workflow_template_alias (alias_name, template_id, description)
VALUES
  ('default',
   'rfc-5-stage@v1',
   'Default 5-stage RFC workflow (Draft→Review→Develop→Merge→Complete)'),
  ('lightweight',
   'lightweight-3-stage@v1',
   'Simplified 3-stage workflow for low-complexity items')
ON CONFLICT (alias_name) DO NOTHING;

-- ── 3. Grants (conditional — roles may not exist in all environments) ─────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_ro') THEN
    GRANT USAGE ON SCHEMA template TO roadmap_ro;
    GRANT SELECT ON template.workflow_template_alias TO roadmap_ro;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_rw') THEN
    GRANT USAGE ON SCHEMA template TO roadmap_rw;
    GRANT SELECT, INSERT, UPDATE ON template.workflow_template_alias TO roadmap_rw;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA template TO agenthive_orchestrator;
    GRANT SELECT ON template.workflow_template_alias TO agenthive_orchestrator;
    GRANT INSERT, UPDATE ON template.workflow_template_alias TO agenthive_orchestrator;
  END IF;
END $$;

COMMIT;
