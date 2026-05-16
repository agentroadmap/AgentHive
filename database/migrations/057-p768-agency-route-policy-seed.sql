-- P768: seed normalized agency_route_policy rows and publish a tenant-side
-- compatibility view for legacy array-shaped readers.
--
-- The canonical table already exists in hiveCentral DDL
-- (database/ddl/hivecentral/003-agency.sql). This migration must not create
-- the table again.

INSERT INTO agency.agency_route_policy (agency_id, route_id, allowed, owner_did)
SELECT a.agency_id, mr.id, true, a.owner_did
FROM agency.agency a
JOIN (
	VALUES
		('claude/agency-bot', 'anthropic'),
		('codex/agency-bot', 'openai'),
		('hermes', 'nous'),
		('hermes/agency-xiaomi', 'nous'),
		('copilot/agency-gary', 'github')
) AS seed(agency_slug, provider_name)
	ON seed.agency_slug = a.agency_id
JOIN hivecentral.model_route mr
	ON mr.route_provider = seed.provider_name
ON CONFLICT (agency_id, route_id, scope, (COALESCE(project_id, 0))) DO NOTHING;

CREATE OR REPLACE VIEW roadmap.agency_route_policy_compat AS
SELECT
	a.agency_id AS agency_identity,
	array_agg(DISTINCT mr.route_provider ORDER BY mr.route_provider)
		FILTER (WHERE arp.allowed = true)  AS allowed_route_providers,
	array_agg(DISTINCT mr.route_provider ORDER BY mr.route_provider)
		FILTER (WHERE arp.allowed = false) AS forbidden_route_providers
FROM agency.agency_route_policy arp
JOIN agency.agency a
	ON a.agency_id = arp.agency_id
JOIN hivecentral.model_route mr
	ON mr.id = arp.route_id
WHERE arp.scope = 'global'
  AND arp.lifecycle_status = 'active'
GROUP BY a.agency_id;
