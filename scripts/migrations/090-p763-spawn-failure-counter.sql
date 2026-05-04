-- P763 C3: Spawn-failure counter feeding agency resolver

BEGIN;

ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS recent_failure_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_at       TIMESTAMPTZ;

-- View: agency spawn failure summary (for diagnostics)
CREATE OR REPLACE VIEW roadmap_workforce.v_agency_failure_summary AS
SELECT
  pr.id,
  pr.agency_id,
  pr.project_id,
  pr.status,
  pr.throttle_count,
  pr.recent_failure_count,
  pr.last_failure_at,
  pr.last_seen_at,
  ar.agent_identity
FROM roadmap_workforce.provider_registry pr
JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
ORDER BY pr.recent_failure_count DESC, pr.last_failure_at DESC NULLS LAST;

GRANT SELECT ON roadmap_workforce.v_agency_failure_summary TO agent_read;

COMMIT;
