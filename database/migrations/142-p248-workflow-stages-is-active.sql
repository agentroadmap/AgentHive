-- P248 AC-7: add is_active to roadmap.workflow_stages
ALTER TABLE roadmap.workflow_stages
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
