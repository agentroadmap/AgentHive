-- P764 C4: Tenant-aware agency in-flight capacity for resolve_agency

BEGIN;

ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS max_in_flight INT NOT NULL DEFAULT 4;

-- View: agency in-flight capacity.
-- Joins active proposal leases to provider_registry to compute in-flight work.
-- proposal_lease.agent_identity is a TEXT identity that matches agent_registry.agent_identity.
CREATE OR REPLACE VIEW roadmap_workforce.v_agency_in_flight AS
SELECT
  pr.id            AS provider_registry_id,
  pr.agency_id,
  pr.project_id,
  pr.max_in_flight,
  pr.status        AS agency_status,
  COUNT(pl.proposal_id) AS in_flight_count,
  MAX(pl.claimed_at)    AS last_claim_at
FROM roadmap_workforce.provider_registry pr
LEFT JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
LEFT JOIN roadmap_proposal.proposal_lease pl
  ON pl.agent_identity = ar.agent_identity
 AND (pl.expires_at IS NULL OR pl.expires_at > now())
 AND pl.released_at IS NULL
GROUP BY pr.id, pr.agency_id, pr.project_id, pr.max_in_flight, pr.status;

GRANT SELECT ON roadmap_workforce.v_agency_in_flight TO agent_read;
GRANT SELECT ON roadmap_workforce.v_agency_in_flight TO agent_write;

COMMIT;
