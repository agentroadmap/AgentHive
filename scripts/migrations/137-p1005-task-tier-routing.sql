-- P1005: Task Tier Routing — Free-Model Labour Pool for Mechanical Ops
--
-- AC-1: Add task_tier (0-3) and required_capabilities JSONB to squad_dispatch
-- AC-2: Upsert copilot agent capabilities with tier=0 jobs
-- AC-9: Seed three copilot agents (pete, pablo, paul) with Tier-0 capabilities
--
-- Implementation notes:
--   - squad_dispatch already has required_capabilities, but task_tier is new
--   - provider_registry.capabilities gets the tier=0 job list for copilots
--   - resolveAgency() will be updated in TypeScript to filter by tier
--   - Tier-0 job runner (AC-4 to AC-7) implemented in tier0-job-runner.ts

BEGIN;

-- ─── AC-1: Add task_tier to squad_dispatch ───────────────────────────────────
-- Existing rows default to tier=2 (mid-tier tasks: standard dev work)
ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS task_tier INTEGER NOT NULL DEFAULT 2;

-- Add check constraint: task_tier must be 0-3
ALTER TABLE roadmap_workforce.squad_dispatch
  DROP CONSTRAINT IF EXISTS squad_dispatch_task_tier_check;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT squad_dispatch_task_tier_check
    CHECK (task_tier >= 0 AND task_tier <= 3);

-- Index for filtering by task_tier when resolving agencies
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_task_tier
  ON roadmap_workforce.squad_dispatch (task_tier, offer_status);

-- ─── AC-2: Upsert copilot agent capabilities with tier=0 job list ────────────
-- The tier=0 job families that copilot agents can handle.
-- These jobs are mechanical/deterministic: testing, linting, changelog generation, etc.
--
-- Copilot agents (pete, pablo, paul) get capabilities:
--   {
--     "tier": 0,
--     "jobs": ["test_run", "typecheck", "lint", "changelog", "log_tail",
--              "dep_audit", "env_audit", "health_check", "boilerplate"]
--   }
--
-- This is a soft capability marker; the tier0-job-runner.ts enforces the actual routing.

UPDATE roadmap_workforce.provider_registry pr
SET capabilities = jsonb_set(
      capabilities,
      '{tier,0,jobs}',
      '["test_run", "typecheck", "lint", "changelog", "log_tail", "dep_audit", "env_audit", "health_check", "boilerplate"]'
    ),
    updated_at = now()
FROM roadmap_workforce.agent_registry ar
WHERE pr.agency_id = ar.id
  AND ar.agent_identity IN ('pete', 'pablo', 'paul');

-- ─── AC-9: Seed three copilot agents (pete, pablo, paul) ─────────────────────
-- If paul doesn't exist yet, insert him. pete and pablo come from P996 migration.
-- All three are set to copilot provider + bot host with Tier-0 capabilities.

INSERT INTO roadmap_workforce.agent_registry
  (agent_identity, agent_type, role, preferred_provider, host_affinity, status)
VALUES
  ('paul', 'agency', 'copilot-agent', 'copilot', 'bot', 'inactive')
ON CONFLICT (agent_identity) DO UPDATE SET
  agent_type        = EXCLUDED.agent_type,
  role              = EXCLUDED.role,
  preferred_provider = EXCLUDED.preferred_provider,
  host_affinity     = EXCLUDED.host_affinity;
  -- Do NOT overwrite status

COMMIT;
