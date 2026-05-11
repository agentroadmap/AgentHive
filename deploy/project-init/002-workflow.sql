-- ============================================================
-- project-init/002-workflow.sql
-- Workflow state machine tables: workflow (root), w_stage,
-- w_transition, w_gate, w_template.
-- Run with: psql -v schema_name=agentHive -f 002-workflow.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- workflow — workflow template registry
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.workflow (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL UNIQUE,          -- 'feature', 'bugfix', 'research', etc.
  display_name     TEXT         NOT NULL,
  description      TEXT,
  initial_status   TEXT         NOT NULL DEFAULT 'Draft',
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER set_updated_at_workflow
  BEFORE UPDATE ON :schema_name.workflow
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.workflow IS
  'Workflow template registry. proposal.type maps to a workflow.slug to determine which state machine applies.';

-- ============================================================
-- w_stage — workflow stages (states in the state machine)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.w_stage (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id      BIGINT       NOT NULL REFERENCES :schema_name.workflow (id) ON DELETE CASCADE,
  name             TEXT         NOT NULL,                 -- 'Draft', 'Review', 'Develop', 'Merge', 'Complete'
  ordinal          INT          NOT NULL DEFAULT 0,
  is_terminal      BOOLEAN      NOT NULL DEFAULT false,
  is_gate          BOOLEAN      NOT NULL DEFAULT false,
  description      TEXT,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  UNIQUE (workflow_id, name)
);

CREATE INDEX IF NOT EXISTS wstage_workflow ON :schema_name.w_stage (workflow_id);

COMMENT ON TABLE :schema_name.w_stage IS
  'Stages (states) within a workflow. ordinal controls display order. '
  'is_gate=true means a reviewer must approve before advancing.';

-- ============================================================
-- w_transition — allowed transitions between stages
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.w_transition (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id      BIGINT       NOT NULL REFERENCES :schema_name.workflow (id) ON DELETE CASCADE,
  from_stage_id    BIGINT       NOT NULL REFERENCES :schema_name.w_stage (id) ON DELETE CASCADE,
  to_stage_id      BIGINT       NOT NULL REFERENCES :schema_name.w_stage (id) ON DELETE CASCADE,
  reason           TEXT,                                  -- 'mature', 'decision', 'iteration', 'discard', etc.
  requires_notes   BOOLEAN      NOT NULL DEFAULT false,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  UNIQUE (workflow_id, from_stage_id, to_stage_id, reason)
);

CREATE INDEX IF NOT EXISTS wtransition_from ON :schema_name.w_transition (from_stage_id);
CREATE INDEX IF NOT EXISTS wtransition_to ON :schema_name.w_transition (to_stage_id);

COMMENT ON TABLE :schema_name.w_transition IS
  'Allowed transitions between workflow stages. reason further discriminates multi-edge transitions.';

-- ============================================================
-- w_gate — gate criteria per stage (checklist evaluated at gates)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.w_gate (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stage_id         BIGINT       NOT NULL REFERENCES :schema_name.w_stage (id) ON DELETE CASCADE,
  check_key        TEXT         NOT NULL,                 -- 'has_ac', 'has_design', 'has_reviewer', etc.
  description      TEXT         NOT NULL,
  is_required      BOOLEAN      NOT NULL DEFAULT true,
  ordinal          INT          NOT NULL DEFAULT 0,
  UNIQUE (stage_id, check_key)
);

CREATE INDEX IF NOT EXISTS wgate_stage ON :schema_name.w_gate (stage_id);

COMMENT ON TABLE :schema_name.w_gate IS
  'Gate criteria evaluated before a proposal can advance through a gating stage.';

-- ============================================================
-- w_template — serialized workflow template snapshots
-- ============================================================
-- Allows exporting and re-importing workflow configurations.
CREATE TABLE IF NOT EXISTS :schema_name.w_template (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL UNIQUE,
  version          INT          NOT NULL DEFAULT 1,
  template_jsonb   JSONB        NOT NULL,                 -- full workflow + stages + transitions + gates
  exported_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  exported_by      TEXT
);

COMMENT ON TABLE :schema_name.w_template IS
  'Serialized snapshots of workflow configurations. Used to clone workflows across projects or restore defaults.';
