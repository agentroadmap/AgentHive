-- V3-C8 (P1440): allow CAPABILITY_MISMATCH as an escalation_log obstacle_type.
--
-- The agency-resolver (AC-4) writes an evidence-bearing escalation when an
-- offer's required_capabilities are not a subset of any agency's capabilities.
-- escalation_log.obstacle_type is governed by a CHECK constraint, so the new
-- value must be added there or the INSERT throws at runtime.
--
-- This migration re-creates the named constraint with the FULL current value
-- set (including PROVIDER_AUTH_DOWN added by migration 188 / V3-C3) plus the
-- new CAPABILITY_MISMATCH value. Idempotent: drops the constraint if present
-- before re-adding.

ALTER TABLE roadmap.escalation_log
  DROP CONSTRAINT IF EXISTS escalation_log_obstacle_type_check;

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
    'PROVIDER_AUTH_DOWN'::text,
    'CAPABILITY_MISMATCH'::text
  ]));
