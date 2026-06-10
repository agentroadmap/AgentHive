-- ============================================================
-- P768-D2: agency_route_policy seed (post-P820 route policy)
-- Schema: normalizes per-agency+route ACLs in hiveCentral
-- Seed: populates roadmap.agency_route_policy (text-array shape)
--       as compat layer during cutover to hiveCentral canonical
-- ============================================================
-- Target: agenthive (roadmap)
-- hiveCentral target: agency.agency_route_policy (already schema'd, no change here)
-- ============================================================

BEGIN;

-- ============================================================
-- AC-1: Ensure roadmap.agency_route_policy table exists
--       with normalized schema matching hiveCentral:
--       (agency_id, route_id, scope, project_id, allowed, lifecycle_status)
--       Join semantics via FK to roadmap.agency (acting as agency registry).
-- ============================================================
CREATE TABLE IF NOT EXISTS roadmap.agency_route_policy (
    id                BIGSERIAL PRIMARY KEY,
    agency_id         TEXT NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    route_id          BIGINT NOT NULL REFERENCES roadmap.model_routes(id) ON DELETE CASCADE,
    scope             TEXT NOT NULL DEFAULT 'global'
                      CHECK (scope IN ('global', 'tenant')),
    project_id        BIGINT,
    allowed           BOOLEAN NOT NULL DEFAULT true,
    lifecycle_status  TEXT NOT NULL DEFAULT 'active'
                      CHECK (lifecycle_status IN ('active', 'deprecated', 'retired', 'blocked')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agency_id, route_id, scope, COALESCE(project_id, 0))
);

CREATE INDEX IF NOT EXISTS idx_agency_route_policy_agency_id
    ON roadmap.agency_route_policy(agency_id);

-- Trigger to update updated_at on every write
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'trg_agency_route_policy_updated_at'
      AND event_object_schema = 'roadmap'
      AND event_object_table = 'agency_route_policy'
  ) THEN
    CREATE TRIGGER trg_agency_route_policy_updated_at
      BEFORE UPDATE ON roadmap.agency_route_policy
      FOR EACH ROW
      EXECUTE FUNCTION (
        CASE
          WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_agency_route_policy_updated_at')
            THEN 'set_agency_route_policy_updated_at'
          ELSE 'set_updated_at'
        END
      )();
  END IF;
END $$;

-- ============================================================
-- AC-2: Seed ALLOW rows for each agency+route+scope pairing.
--       Based on roadmap.agency + roadmap.model_routes registries.
--       For each agency, allow all routes with matching provider.
--       Scope='global' for tenant-wide policy.
-- ============================================================

-- Seed logic: for each (agency, model_route) pair where route provider
-- matches the agency's affiliated provider, insert an allow row.
-- Currently 3 active agencies: claude-bot-gary.a, codex-bot-andy.a, antigravity-bot-gary.a

INSERT INTO roadmap.agency_route_policy (agency_id, route_id, scope, project_id, allowed, lifecycle_status)
SELECT
  a.agency_id,
  mr.id,
  'global' AS scope,
  NULL::bigint AS project_id,
  true AS allowed,
  'active' AS lifecycle_status
FROM roadmap.agency a
CROSS JOIN roadmap.model_routes mr
WHERE (
  (a.agency_id = 'claude-bot-gary.a' AND mr.route_provider = 'anthropic')
  OR (a.agency_id = 'codex-bot-andy.a' AND mr.route_provider = 'openai')
  OR (a.agency_id = 'antigravity-bot-gary.a' AND mr.route_provider = 'google')
)
AND a.provider IN ('claude', 'codex', 'antigravity')
AND mr.is_enabled = true
ON CONFLICT (agency_id, route_id, scope, COALESCE(project_id, 0)) DO UPDATE SET
  allowed = EXCLUDED.allowed,
  lifecycle_status = EXCLUDED.lifecycle_status,
  updated_at = now();

-- ============================================================
-- AC-4: Create compatibility view roadmap.agency_route_policy_compat
--       Presents text-array shape for code expecting old schema.
--       Aggregates normalized rows back into allowed/forbidden provider arrays.
-- ============================================================

CREATE OR REPLACE VIEW roadmap.agency_route_policy_compat AS
  SELECT
    a.agency_id,
    array_agg(DISTINCT mr.route_provider) FILTER (WHERE arp.allowed = true)
      AS allowed_route_providers,
    array_agg(DISTINCT mr.route_provider) FILTER (WHERE arp.allowed = false)
      AS forbidden_route_providers
  FROM roadmap.agency a
  LEFT JOIN roadmap.agency_route_policy arp ON arp.agency_id = a.agency_id
  LEFT JOIN roadmap.model_routes mr ON mr.id = arp.route_id
  WHERE arp.lifecycle_status = 'active' OR arp.id IS NULL
  GROUP BY a.agency_id;

COMMENT ON VIEW roadmap.agency_route_policy_compat IS
  'Compatibility view for agency_route_policy: presents text-array shape '
  '(allowed_route_providers, forbidden_route_providers) for backward compatibility. '
  'Aggregates normalized (agency_id, route_id, allowed) rows by route provider.';

-- ============================================================
-- AC-5: Verify seed data inserted
-- ============================================================
-- SELECT 'Verify agency_route_policy seed:' as step;
-- SELECT agency_identity, allowed_route_providers, forbidden_route_providers
-- FROM roadmap.agency_route_policy
-- ORDER BY agency_identity;

COMMIT;
