-- Rollback for P928 — Agent registry route binding for backend visibility (agency scope).
BEGIN;

DROP VIEW IF EXISTS roadmap_workforce.v_agent_with_route;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
      JOIN pg_namespace  n ON n.oid = t.relnamespace
     WHERE n.nspname = 'roadmap_workforce'
       AND t.relname = 'agent_registry'
       AND c.conname = 'agent_registry_current_route_fk'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_registry
      DROP CONSTRAINT agent_registry_current_route_fk;
  END IF;
END $$;

ALTER TABLE roadmap_workforce.agent_registry
  DROP COLUMN IF EXISTS current_route_id;

COMMIT;
