-- P3508 AC-5: Add scoped_project_id to roadmap.operator_token
--
-- Enables per-token project scope: an operator token can be bound to exactly
-- one project. Control-plane actions check that the caller's token scope
-- matches the target project before proceeding.
--
-- Existing tokens keep scoped_project_id = NULL (full scope, no lockout).
-- A NULL scoped_project_id means the token may act on any project.
--
-- ON DELETE RESTRICT: cannot delete a project while tokens are scoped to it —
-- forces explicit revocation/unscoping before project removal.

BEGIN;

ALTER TABLE roadmap.operator_token
  ADD COLUMN IF NOT EXISTS scoped_project_id BIGINT
    REFERENCES roadmap.project(project_id) ON DELETE RESTRICT;

COMMENT ON COLUMN roadmap.operator_token.scoped_project_id IS
  'P3508 AC-5: If non-NULL, this token may only act on the specified project. '
  'NULL = full scope (all projects). Checked by authorizeOperator() when ctx.targetProjectId is provided.';

CREATE INDEX IF NOT EXISTS idx_operator_token_project_scope
  ON roadmap.operator_token (scoped_project_id)
  WHERE scoped_project_id IS NOT NULL;

COMMIT;
