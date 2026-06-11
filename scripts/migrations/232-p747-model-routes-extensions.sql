/**
 * P747: Extensions to roadmap.model_routes for Comprehensive Routing
 *
 * AC-5: Adds can_spawn_workers column for role-based eligibility filtering
 * AC-7: Adds fallback_route_id for cooldown fallback chain
 *
 * These columns support the multi-dimensional routing resolution in P747.
 */

-- AC-5: Add can_spawn_workers flag for architecture/review task gating
ALTER TABLE roadmap.model_routes
ADD COLUMN IF NOT EXISTS can_spawn_workers BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN roadmap.model_routes.can_spawn_workers IS
  'P747 AC-5: Indicates route capability to spawn sub-agents. Required for architecture/review roles.';

-- Create index for role-based filtering
CREATE INDEX IF NOT EXISTS idx_model_routes_spawn_workers
  ON roadmap.model_routes (can_spawn_workers)
  WHERE is_enabled = true;

-- AC-7: Add fallback_route_id for cooldown fallback chain
ALTER TABLE roadmap.model_routes
ADD COLUMN IF NOT EXISTS fallback_route_id BIGINT;

-- Add foreign key constraint to self
ALTER TABLE roadmap.model_routes
ADD CONSTRAINT fk_model_routes_fallback FOREIGN KEY (fallback_route_id)
  REFERENCES roadmap.model_routes(id) ON DELETE SET NULL;

COMMENT ON COLUMN roadmap.model_routes.fallback_route_id IS
  'P747 AC-7: Chain link for cooldown fallback. When this route is throttled, attempt fallback_route_id.';

-- Create index for fallback chain traversal
CREATE INDEX IF NOT EXISTS idx_model_routes_fallback
  ON roadmap.model_routes (fallback_route_id)
  WHERE fallback_route_id IS NOT NULL;
