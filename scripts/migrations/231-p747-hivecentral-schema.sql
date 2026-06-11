/**
 * P747 AC-2: HiveCentral Schema for Host Model Policy
 *
 * Creates hivecentral schema as the control plane hub for infrastructure policies.
 * Defines host_model_policy with per-row (is_allowed, deny_reason) structure
 * for precise host-level route eligibility enforcement.
 *
 * Note: Coordinate with P595 timeline. If P595 has already created hivecentral,
 * this migration is a no-op. If not, this establishes the schema authority.
 *
 * Schema authority: hivecentral (control plane, host-wide policies)
 */

-- Create hivecentral schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS hivecentral;

-- Grant usage to role
GRANT USAGE ON SCHEMA hivecentral TO agenthive_orchestrator;

-- Create host_model_policy table (per-row boolean + deny_reason)
CREATE TABLE IF NOT EXISTS hivecentral.host_model_policy (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id TEXT NOT NULL,
  route_id BIGINT NOT NULL,
  is_allowed BOOLEAN NOT NULL DEFAULT true,
  deny_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT host_route_policy_unique UNIQUE (host_id, route_id),
  CONSTRAINT deny_reason_requires_denial CHECK (
    (is_allowed = false AND deny_reason IS NOT NULL) OR is_allowed = true
  )
);

-- Index for fast policy lookup during routing
CREATE INDEX IF NOT EXISTS idx_host_model_policy_lookup
  ON hivecentral.host_model_policy (host_id, route_id)
  WHERE is_allowed = false;

-- Index for auditing by host
CREATE INDEX IF NOT EXISTS idx_host_model_policy_host
  ON hivecentral.host_model_policy (host_id, updated_at DESC);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON hivecentral.host_model_policy TO agenthive_orchestrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hivecentral TO agenthive_orchestrator;

-- Add comment documenting the schema authority
COMMENT ON TABLE hivecentral.host_model_policy IS
  'P747 AC-2: Host-wide route eligibility policies. Canonical authority for compute-host-level route restrictions.';

COMMENT ON COLUMN hivecentral.host_model_policy.is_allowed IS
  'Route eligibility flag. false eliminates route from consideration on this host.';

COMMENT ON COLUMN hivecentral.host_model_policy.deny_reason IS
  'Human-readable reason for denial; required when is_allowed=false.';
