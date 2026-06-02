/**
 * P1435-C3: Per-(OS-user, provider) auth model + fail-loud
 *
 * 1. Add PROVIDER_AUTH_DOWN to escalation_log.obstacle_type enum
 * 2. Add auth_down_until column to model_routes for per-provider auth cooldown
 * 3. Index for efficient filtering in eligibility checks
 */

-- Drop and recreate the escalation_log_obstacle_type_check constraint with the new enum value
ALTER TABLE roadmap.escalation_log
  DROP CONSTRAINT escalation_log_obstacle_type_check;

ALTER TABLE roadmap.escalation_log
  ADD CONSTRAINT escalation_log_obstacle_type_check
    CHECK (obstacle_type = ANY (ARRAY[
      'BUDGET_EXHAUSTED'::text,
      'LOOP_DETECTED'::text,
      'CYCLE_DETECTED'::text,
      'AGENT_DEAD'::text,
      'PIPELINE_BLOCKED'::text,
      'AC_GATE_FAILED'::text,
      'DEPENDENCY_UNRESOLVED'::text,
      'SPAWN_POLICY_VIOLATION'::text,
      'REPEATED_MESSAGE_DENIAL'::text,
      'UNAUTHORIZED_GATE_TRANSITION'::text,
      'PROVIDER_AUTH_DOWN'::text
    ]));

-- Add auth_down_until column to model_routes for per-provider auth cooldown
-- Parallel structure to cooldown_until but semantically distinct
ALTER TABLE roadmap.model_routes
  ADD COLUMN auth_down_until timestamp with time zone;

-- Index for efficient filtering of routes with active auth cooldown
CREATE INDEX idx_model_routes_auth_down
  ON roadmap.model_routes (auth_down_until)
  WHERE auth_down_until IS NOT NULL;
