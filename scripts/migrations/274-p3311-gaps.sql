-- P3311 gap-close (AC-6): correct task_class taxonomy + agent_runs.task_class column.
--
-- Migration 271 seeded roadmap_scoring.task_class_registry with values that
-- pre-date the canonical TASK_CLASS enum (difficulty-assessor.ts). This
-- migration adds the correct enum values and stamps agent_runs.task_class so
-- the rollup (fn_p3311_rollup_reliability) can read class directly from the row
-- instead of falling back to the squad_dispatch lateral join.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Correct taxonomy: add canonical TASK_CLASS values missing from migration 271
-- ---------------------------------------------------------------------------
-- Canonical values from src/core/orchestration/difficulty-assessor.ts:
--   mcp_protocol | code_dev | gate_review | triage | mechanical | research
-- Migration 271 shipped: mcp_protocol | develop | merge | gate_review | enhance | generic
-- We add the missing correct values and the '_global' sentinel.
INSERT INTO roadmap_scoring.task_class_registry (task_class, task_family, description) VALUES
  ('code_dev',    'build',       'Code authoring + test development (canonical name; replaces "develop")'),
  ('triage',      'judgment',    'Proposal triage — assess priority, assign, route'),
  ('mechanical',  'generic',     'Deterministic / low-judgment mechanical operations'),
  ('research',    'judgment',    'Open-ended research, investigation, or spike work'),
  ('_global',     '_global',     'Sentinel: aggregate across all task classes for cold-start fallback')
ON CONFLICT (task_class) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Add task_class column to agent_runs (AC-6: stamped at INSERT time)
-- ---------------------------------------------------------------------------
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS task_class TEXT;

-- Backfill from squad_dispatch for historical rows (best-effort; NULLs acceptable).
UPDATE roadmap_workforce.agent_runs ar
SET    task_class = sd.task_class
FROM   roadmap_workforce.squad_dispatch sd
WHERE  sd.proposal_id = ar.proposal_id
  AND  sd.task_class  IS NOT NULL
  AND  ar.task_class  IS NULL;

COMMIT;
