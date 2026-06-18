-- P527: Cubic Cleanup Reaper — Orphan Detection and Lifecycle Enforcement
-- Adds metadata column to host_model_policy for max_active_cubics_per_host configuration

-- Add metadata column if it doesn't exist
ALTER TABLE roadmap.host_model_policy
ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- Create index on metadata for efficient queries
CREATE INDEX IF NOT EXISTS idx_host_model_policy_max_active_cubics
  ON roadmap.host_model_policy
  USING gin(metadata)
  WHERE metadata ? 'max_active_cubics_per_host';

-- Ensure cubic_cleanup_audit table has necessary constraints and indexes
-- (already created by P196 migration 190, but we verify idempotency)
CREATE TABLE IF NOT EXISTS roadmap.cubic_cleanup_audit (
  id bigserial PRIMARY KEY,
  cubic_id text NOT NULL,
  action text NOT NULL,
  orphan_rule integer,
  reason text,
  recovery_path text,
  worktree_path text,
  actor text,
  proposal_id bigint REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cubic_cleanup_audit_action_check
    CHECK (action IN ('PRESERVED', 'DELETED', 'LEASE_RELEASED', 'FORCE_REAP', 'ORPHANED')),
  CONSTRAINT cubic_cleanup_audit_orphan_rule_check
    CHECK (orphan_rule IS NULL OR orphan_rule BETWEEN 1 AND 4)
);

-- Ensure indexes exist
CREATE INDEX IF NOT EXISTS idx_cubic_cleanup_audit_cubic
  ON roadmap.cubic_cleanup_audit(cubic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cubic_cleanup_audit_action
  ON roadmap.cubic_cleanup_audit(action, created_at DESC);

-- Create function to check cubic budget (used by cubic_create handlers)
-- Note: The actual enforcement is in the application layer via checkCubicCreateBudget()
CREATE OR REPLACE FUNCTION roadmap.fn_check_cubic_budget(
  p_host_name text,
  p_default_max integer DEFAULT 10
)
RETURNS TABLE(
  host_name text,
  active_count bigint,
  max_active integer,
  allowed boolean
)
LANGUAGE sql STABLE
AS $$
  WITH host_max AS (
    SELECT COALESCE(
      CASE
        WHEN metadata ? 'max_active_cubics_per_host'
         AND metadata->>'max_active_cubics_per_host' ~ '^[0-9]+$'
        THEN (metadata->>'max_active_cubics_per_host')::int
      END,
      p_default_max
    ) AS max_val
    FROM roadmap.host_model_policy
    WHERE host_name = p_host_name
  ),
  active_count_cte AS (
    SELECT COUNT(*)::int AS count
    FROM roadmap.cubics
    WHERE status NOT IN ('completed', 'complete', 'expired', 'terminated', 'recycled', 'orphaned')
      AND COALESCE(
        metadata->>'host_name',
        CASE WHEN worktree_path LIKE '/data/code/worktree/%' THEN p_host_name ELSE NULL END
      ) = p_host_name
  )
  SELECT
    p_host_name,
    COALESCE(ac.count, 0),
    COALESCE(hm.max_val, p_default_max),
    COALESCE(ac.count, 0) < COALESCE(hm.max_val, p_default_max)
  FROM host_max hm
  CROSS JOIN active_count_cte ac;
$$;
