-- Tenant health check function.
-- Returns a JSON object with tenant information and migration status.

CREATE OR REPLACE FUNCTION ${SCHEMA_PREFIX}meta.health()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_slug text;
  v_migrations int;
BEGIN
  SELECT v INTO v_slug FROM ${SCHEMA_PREFIX}meta.tenant_info WHERE k = 'slug';
  SELECT count(*) INTO v_migrations FROM ${SCHEMA_PREFIX}meta.migrations;

  RETURN jsonb_build_object(
    'ok', true,
    'slug', v_slug,
    'migrations_applied', v_migrations,
    'now', now()
  );
END;
$$;
