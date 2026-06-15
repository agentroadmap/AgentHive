-- Migration 271: P3313 AC-5 — operator route-class override table
-- Allows operator to pin or ban a route for a task_class via MCP/CLI.
-- pin: this route is preferred for this task_class (softens other filters)
-- ban: this route is excluded for this task_class (hard exclusion)
-- All writes are audited via updated_by + reason.

CREATE TABLE IF NOT EXISTS roadmap_workforce.route_class_override (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_class    TEXT        NOT NULL,
  route_id      INTEGER     NOT NULL REFERENCES roadmap.model_routes(id) ON DELETE CASCADE,
  action        TEXT        NOT NULL CHECK (action IN ('pin', 'ban')),
  reason        TEXT,
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  UNIQUE (task_class, route_id)
);

COMMENT ON TABLE roadmap_workforce.route_class_override IS
  'P3313 AC-5: operator overrides to pin or ban a route for a task_class. Audited.';

CREATE INDEX IF NOT EXISTS idx_rco_task_class_active
  ON roadmap_workforce.route_class_override (task_class)
  WHERE expires_at IS NULL OR expires_at > now();
