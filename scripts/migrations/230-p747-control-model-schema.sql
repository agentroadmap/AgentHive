/**
 * P747 AC-3: Control Model Schema for Project Route Policy
 *
 * Creates control_model schema as the canonical authority for per-tenant routing policies.
 * Defines project_route_policy with per-row (is_allowed, deny_reason) structure
 * for precise policy auditing and rule expression.
 *
 * Schema authority: control_model (control plane policies)
 */

-- Create control_model schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS control_model;

-- Grant usage to role
GRANT USAGE ON SCHEMA control_model TO agenthive_orchestrator;

-- Create project_route_policy table (per-row boolean + deny_reason)
CREATE TABLE IF NOT EXISTS control_model.project_route_policy (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL,
  route_id BIGINT NOT NULL,
  is_allowed BOOLEAN NOT NULL DEFAULT true,
  deny_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT project_route_policy_unique UNIQUE (project_id, route_id),
  CONSTRAINT deny_reason_requires_denial CHECK (
    (is_allowed = false AND deny_reason IS NOT NULL) OR is_allowed = true
  )
);

-- Index for fast policy lookup during routing
CREATE INDEX IF NOT EXISTS idx_project_route_policy_lookup
  ON control_model.project_route_policy (project_id, route_id)
  WHERE is_allowed = false;

-- Index for auditing by project
CREATE INDEX IF NOT EXISTS idx_project_route_policy_project
  ON control_model.project_route_policy (project_id, updated_at DESC);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON control_model.project_route_policy TO agenthive_orchestrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control_model TO agenthive_orchestrator;

-- Add comment documenting the schema authority
COMMENT ON TABLE control_model.project_route_policy IS
  'P747 AC-3: Per-tenant route eligibility policies. Canonical authority for project-scoped route restrictions.';

COMMENT ON COLUMN control_model.project_route_policy.is_allowed IS
  'Route eligibility flag. false eliminates route from consideration.';

COMMENT ON COLUMN control_model.project_route_policy.deny_reason IS
  'Human-readable reason for denial; required when is_allowed=false.';
