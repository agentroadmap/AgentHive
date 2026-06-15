-- P3508 AC-5: Add scoped_project_id to operator_token for per-project access control.
--
-- A NULL scoped_project_id means full scope (existing tokens keep full access).
-- A non-NULL value restricts the token to a single project; cross-project actions
-- with that token return 403.
--
-- ON DELETE RESTRICT prevents removing a project that still has scoped tokens,
-- forcing explicit token cleanup before project removal.

BEGIN;

ALTER TABLE roadmap.operator_token
    ADD COLUMN IF NOT EXISTS scoped_project_id bigint
        REFERENCES roadmap.project(project_id) ON DELETE RESTRICT;

COMMENT ON COLUMN roadmap.operator_token.scoped_project_id IS
    'P3508: When non-NULL, restricts this token to the given project. '
    'Cross-project actions return 403. NULL = full scope (default, no lockout).';

CREATE INDEX IF NOT EXISTS idx_operator_token_project_scope
    ON roadmap.operator_token (scoped_project_id)
    WHERE scoped_project_id IS NOT NULL;

COMMIT;
