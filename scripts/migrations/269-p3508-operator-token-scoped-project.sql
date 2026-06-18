-- P3508 AC-5: Add scoped_project_id to operator_token so a bearer token can
-- be bound to a single project. NULL = full scope (no lockout regression).
ALTER TABLE roadmap.operator_token
  ADD COLUMN IF NOT EXISTS scoped_project_id BIGINT
    REFERENCES roadmap.project(project_id) ON DELETE RESTRICT;

COMMENT ON COLUMN roadmap.operator_token.scoped_project_id IS
  'When non-NULL, restricts this token to a single project. '
  'Callers whose targetProjectId differs receive 403 (project scope). '
  'NULL = full scope; existing rows are unaffected.';
