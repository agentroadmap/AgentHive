/**
 * P2323/AC-5: Heartbeat-Gated Status Surfaces
 *
 * Ensures that any query checking agent/agency "active" status gates on recent
 * heartbeat (<60s), not just the raw status column. This prevents test fixtures
 * with NULL/stale heartbeat from appearing active in dashboards.
 *
 * Changes:
 * 1. Create v_agent_status (heartbeat-gated agent registry view)
 * 2. Create v_agent_is_active (boolean helper)
 * 3. Document that v_agency_status.dispatchable (migration 186) is the canonical
 *    agency-active check
 * 4. Add helper functions for programmatic checks
 */

-- ────────────────────────────────────────────────────────────────────────────
-- AC-5.1: Heartbeat-gated agent_registry status view
-- ────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS roadmap.v_agent_status CASCADE;

CREATE VIEW roadmap.v_agent_status AS
SELECT
  ar.id,
  ar.agent_identity,
  ar.agent_type,
  ar.status,
  ar.last_seen_at,
  EXTRACT(EPOCH FROM (now() - ar.last_seen_at)) AS silence_seconds,
  ar.status = 'active'::text
    AND ar.last_seen_at IS NOT NULL
    AND (now() - ar.last_seen_at) < '00:01:00'::interval AS dispatchable,
  ar.created_at,
  ar.updated_at,
  ar.project_id
FROM roadmap_workforce.agent_registry ar
WHERE ar.status <> 'suspended'::text;

COMMENT ON VIEW roadmap.v_agent_status IS
  'P2323/AC-5: Heartbeat-gated agent status. "dispatchable" requires recent heartbeat (<60s), not just raw status.';

COMMENT ON COLUMN roadmap.v_agent_status.dispatchable IS
  'TRUE if: status=active AND last_seen_at IS NOT NULL AND now()-last_seen_at < 60s. FALSE otherwise. Use for all "is this agent active?" checks.';

-- ────────────────────────────────────────────────────────────────────────────
-- AC-5.2: Heartbeat-gated boolean helper for agent_registry
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_agent_is_active(
  agent_identity TEXT,
  heartbeat_ttl INTERVAL DEFAULT '60 seconds'
)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM roadmap_workforce.agent_registry ar
    WHERE ar.agent_identity = $1
      AND ar.status = 'active'
      AND ar.last_seen_at IS NOT NULL
      AND (now() - ar.last_seen_at) < heartbeat_ttl
  )
$$;

COMMENT ON FUNCTION roadmap_workforce.fn_agent_is_active IS
  'P2323/AC-5: Check if an agent is active based on recent heartbeat, not raw status.';

-- ────────────────────────────────────────────────────────────────────────────
-- AC-5.3: Heartbeat-gated boolean helper for agency
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_agency_is_active(
  agency_id TEXT,
  heartbeat_ttl INTERVAL DEFAULT '60 seconds'
)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM roadmap.agency a
    WHERE a.agency_id = $1
      AND a.status = 'active'
      AND a.last_heartbeat_at IS NOT NULL
      AND (now() - a.last_heartbeat_at) < heartbeat_ttl
  )
$$;

COMMENT ON FUNCTION roadmap.fn_agency_is_active IS
  'P2323/AC-5: Check if an agency is active based on recent heartbeat, not raw status.';

-- ────────────────────────────────────────────────────────────────────────────
-- AC-5.4: Active count functions (for monitoring/dashboards)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_count_active_agents(
  heartbeat_ttl INTERVAL DEFAULT '60 seconds'
)
RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT COUNT(*)
  FROM roadmap_workforce.agent_registry ar
  WHERE ar.status = 'active'
    AND ar.last_seen_at IS NOT NULL
    AND (now() - ar.last_seen_at) < heartbeat_ttl
$$;

COMMENT ON FUNCTION roadmap_workforce.fn_count_active_agents IS
  'P2323/AC-5: Count agents that are actively heartbeating (< 60s since last_seen_at).';

CREATE OR REPLACE FUNCTION roadmap.fn_count_active_agencies(
  heartbeat_ttl INTERVAL DEFAULT '60 seconds'
)
RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT COUNT(*)
  FROM roadmap.agency a
  WHERE a.status = 'active'
    AND a.last_heartbeat_at IS NOT NULL
    AND (now() - a.last_heartbeat_at) < heartbeat_ttl
$$;

COMMENT ON FUNCTION roadmap.fn_count_active_agencies IS
  'P2323/AC-5: Count agencies that are actively heartbeating (< 60s since last_heartbeat_at).';
