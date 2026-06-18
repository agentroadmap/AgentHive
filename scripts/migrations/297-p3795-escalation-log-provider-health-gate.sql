-- Migration 297: P3795 — add PROVIDER_HEALTH_GATE to escalation_log obstacle_type constraint.
--
-- offer-dispatch-handler.ts inserts obstacle_type = 'PROVIDER_HEALTH_GATE' when the
-- P3795 hard routing gate blocks dispatch to an unhealthy provider. The CHECK constraint
-- on escalation_log.obstacle_type does not include this value (last extended by migration
-- 189 with CAPABILITY_MISMATCH), so every AC-3 INSERT throws a constraint violation and
-- falls through to the non-blocking catch block — escalations are silently dropped.
--
-- This migration re-creates the named constraint with the full current value set plus
-- PROVIDER_HEALTH_GATE. Idempotent: drops the constraint before re-adding.

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
    'CAPABILITY_MISMATCH'::text,
    'PROVIDER_HEALTH_GATE'::text
  ]));

INSERT INTO roadmap.migration_history (filename, checksum_sha256, applied_at, applied_by, environment)
VALUES ('297-p3795-escalation-log-provider-health-gate.sql', 'manual', now(), 'claude-bot-gary', 'production')
ON CONFLICT (filename) DO NOTHING;
