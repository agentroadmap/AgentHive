-- P482 Phase 2: Column Propagation & Composite FK Rebuild
-- AC #1-#8, AC #100 (DB-optimizer: composite FK fix), AC #101 (ANALYZE post-backfill)
-- Adds project_id BIGINT NOT NULL DEFAULT 1 to 10 scoped tables with FK to roadmap.project(project_id).
-- Composite indexes per AC #3; critical FK fix: workflow_templates PK becomes composite (project_id, id).
-- All tables small (<22K rows), lock window 10-50ms per DB-optimizer measurement — single-tx safe.
-- ANALYZE on all 10 tables post-backfill (AC #101).

BEGIN;

-- Phase 2a: ADD project_id to all 10 tables (order matters for FK resolution)
-- Default to 1 (agenthive) to keep existing handlers unchanged (Phase 3 defers handler refactor)

ALTER TABLE roadmap.cubics
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap.workflows
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap.message_ledger
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap_proposal.proposal_dependencies
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap_proposal.proposal_discussions
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap_proposal.proposal_acceptance_criteria
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap_proposal.proposal_reviews
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap_proposal.proposal_event
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

ALTER TABLE roadmap.workflow_templates
  ADD COLUMN project_id BIGINT NOT NULL DEFAULT 1
  REFERENCES roadmap.project(project_id);

-- Phase 2b: Composite indexes per AC #3

-- cubics(project_id, status)
CREATE INDEX idx_cubics_project_status ON roadmap.cubics(project_id, status);

-- workflows(project_id, current_stage)
CREATE INDEX idx_workflows_project_stage ON roadmap.workflows(project_id, current_stage);

-- agent_registry(project_id, status)
CREATE INDEX idx_agent_registry_project_status ON roadmap_workforce.agent_registry(project_id, status);

-- proposal_discussions(project_id, proposal_id)
CREATE INDEX idx_proposal_discussions_project_proposal ON roadmap_proposal.proposal_discussions(project_id, proposal_id);

-- proposal_reviews(project_id, proposal_id)
CREATE INDEX idx_proposal_reviews_project_proposal ON roadmap_proposal.proposal_reviews(project_id, proposal_id);

-- Phase 2c: Critical FK fix (AC #100 — DB-optimizer)
-- workflow_templates PK becomes composite (project_id, id);
-- workflows.template_id FK rebuilt as composite (project_id, template_id) → workflow_templates(project_id, id)
-- Steps in exact order to satisfy FK references during rebuild:
--   a. project_id columns already added above (Phase 2a)
--   b. Both default to 1, so existing FK rows match
--   c-j. Rebuild PK and dependent FKs in strict sequence to avoid conflicts

-- c. Drop all dependent FKs that reference workflow_templates(id)
-- Note: workflow_roles, workflow_stages, workflow_transitions stay as single-column FKs
-- because they're internal configuration (no cross-project boundary), only workflows needs composite FK

ALTER TABLE roadmap.workflows
  DROP CONSTRAINT workflows_template_fkey;

ALTER TABLE roadmap.workflow_roles
  DROP CONSTRAINT workflow_roles_template_fkey;

ALTER TABLE roadmap.workflow_stages
  DROP CONSTRAINT workflow_stages_template_fkey;

ALTER TABLE roadmap.workflow_transitions
  DROP CONSTRAINT workflow_transitions_template_fkey;

ALTER TABLE roadmap_proposal.proposal_type_config
  DROP CONSTRAINT proposal_type_config_wf_fkey;

ALTER TABLE roadmap_proposal.proposal_valid_transitions
  DROP CONSTRAINT proposal_valid_transitions_wf_fkey;

-- d. Drop existing PK
ALTER TABLE roadmap.workflow_templates
  DROP CONSTRAINT workflow_templates_pkey;

-- e. Add composite PK (project_id, id)
ALTER TABLE roadmap.workflow_templates
  ADD PRIMARY KEY (project_id, id);

-- f. Preserve single-id lookups via unique index on id (many handlers still use single-column lookups)
CREATE UNIQUE INDEX workflow_templates_id_uniq ON roadmap.workflow_templates(id);

-- g. Rebuild FK from workflows (now composite: project_id, template_id)
ALTER TABLE roadmap.workflows
  ADD CONSTRAINT workflows_template_fkey
  FOREIGN KEY (project_id, template_id)
  REFERENCES roadmap.workflow_templates(project_id, id)
  ON DELETE RESTRICT;

-- h. Rebuild FKs for configuration tables (stay as single-column template_id)
ALTER TABLE roadmap.workflow_roles
  ADD CONSTRAINT workflow_roles_template_fkey
  FOREIGN KEY (template_id)
  REFERENCES roadmap.workflow_templates(id)
  ON DELETE CASCADE;

ALTER TABLE roadmap.workflow_stages
  ADD CONSTRAINT workflow_stages_template_fkey
  FOREIGN KEY (template_id)
  REFERENCES roadmap.workflow_templates(id)
  ON DELETE CASCADE;

ALTER TABLE roadmap.workflow_transitions
  ADD CONSTRAINT workflow_transitions_template_fkey
  FOREIGN KEY (template_id)
  REFERENCES roadmap.workflow_templates(id)
  ON DELETE CASCADE;

-- i. Rebuild FKs referencing workflow_templates.name (unchanged; they use name, not id)
ALTER TABLE roadmap_proposal.proposal_type_config
  ADD CONSTRAINT proposal_type_config_wf_fkey
  FOREIGN KEY (workflow_name)
  REFERENCES roadmap.workflow_templates(name)
  ON DELETE RESTRICT;

ALTER TABLE roadmap_proposal.proposal_valid_transitions
  ADD CONSTRAINT proposal_valid_transitions_wf_fkey
  FOREIGN KEY (workflow_name)
  REFERENCES roadmap.workflow_templates(name)
  ON DELETE RESTRICT;

-- Phase 2d: ANALYZE all 10 tables post-backfill (AC #101)
-- Recomputes query-planner statistics to account for new distribution after project_id backfill

ANALYZE roadmap.cubics;
ANALYZE roadmap.workflows;
ANALYZE roadmap_workforce.agent_registry;
ANALYZE roadmap.message_ledger;
ANALYZE roadmap_proposal.proposal_dependencies;
ANALYZE roadmap_proposal.proposal_discussions;
ANALYZE roadmap_proposal.proposal_acceptance_criteria;
ANALYZE roadmap_proposal.proposal_reviews;
ANALYZE roadmap_proposal.proposal_event;
ANALYZE roadmap.workflow_templates;

COMMIT;
