-- P771 D5 prerequisite: roadmap.agency_route_policy
-- Stores per-agency route allowlist/denylist used by resolveModelRoute() Layer 3.
-- P768 will seed this table once P501 real agency data is available.
-- Empty table = open policy (all routes allowed for all agencies).

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap.agency_route_policy (
  id                        BIGSERIAL   PRIMARY KEY,
  agency_identity           TEXT        NOT NULL UNIQUE,
  allowed_route_providers   TEXT[]      NOT NULL DEFAULT '{}',
  forbidden_route_providers TEXT[]      NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE roadmap.agency_route_policy IS
  'Per-agency route allowlist/denylist. '
  'Empty allowed_route_providers means any provider is permitted. '
  'forbidden_route_providers always excludes those providers. '
  'Seeded by P768 once P501 agency data is in hiveCentral.';

CREATE INDEX IF NOT EXISTS idx_agency_route_policy_identity
  ON roadmap.agency_route_policy (agency_identity);

CREATE OR REPLACE FUNCTION roadmap.set_agency_route_policy_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_agency_route_policy_updated_at ON roadmap.agency_route_policy;
CREATE TRIGGER trg_agency_route_policy_updated_at
  BEFORE UPDATE ON roadmap.agency_route_policy
  FOR EACH ROW EXECUTE FUNCTION roadmap.set_agency_route_policy_updated_at();

GRANT SELECT ON roadmap.agency_route_policy TO agent_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.agency_route_policy TO agent_write;

COMMIT;

-- Rollback:
--   DROP TABLE IF EXISTS roadmap.agency_route_policy;
--   DROP FUNCTION IF EXISTS roadmap.set_agency_route_policy_updated_at();
