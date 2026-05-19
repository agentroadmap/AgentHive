-- env: prod
-- P928 — Agent registry route binding for backend visibility (agency scope).
BEGIN;

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS current_route_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
      JOIN pg_namespace  n ON n.oid = t.relnamespace
     WHERE n.nspname = 'roadmap_workforce'
       AND t.relname = 'agent_registry'
       AND c.conname = 'agent_registry_current_route_fk'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_registry
      ADD CONSTRAINT agent_registry_current_route_fk
      FOREIGN KEY (current_route_id) REFERENCES roadmap.model_routes(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN roadmap_workforce.agent_registry.current_route_id IS
  'Live binding to roadmap.model_routes(id) for the route this agent is currently invoking. NULL means unbound (legacy, or boot has not run resolveAgencyCurrentRoute yet). Set/refreshed on selfRegisterAgency.';

-- View: agent_registry × model_routes. agent_registry has overlapping columns
-- (cli_path, base_url, agent_cli, api_spec, id, created_at) so model_routes
-- columns are aliased with `route_` prefix to disambiguate.
CREATE OR REPLACE VIEW roadmap_workforce.v_agent_with_route AS
SELECT
  ar.*,
  mr.route_provider AS route_route_provider,
  mr.model_name     AS route_model_name,
  mr.plan_type      AS route_plan_type,
  mr.cli_path       AS route_cli_path,
  mr.base_url       AS route_base_url
  FROM roadmap_workforce.agent_registry ar
  LEFT JOIN roadmap.model_routes mr ON mr.id = ar.current_route_id;

COMMIT;
