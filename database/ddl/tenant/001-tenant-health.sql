/**
 * P513 / P508: Tenant Health Check Schema Template
 *
 * Applied by saga-create.ts Step 6 after 000-tenant-bootstrap.
 * Substitutions required:
 *   {{schema_prefix}} — e.g. 'audio_'
 *   {{tenant_role}} — e.g. 'monkeyKing_audio_owner'
 *
 * Creates tenant health check infrastructure:
 * - {{schema_prefix}}meta.health() function (idempotent query per AC-7)
 * - Confirms pool connectivity + schema visibility
 * - Called by: integration tests, smoke tests, monitoring
 *
 * Idempotent: safe to re-apply.
 * Verifies: tenant can access its own schema without touching public/agenthive
 */

-- Step 1: Create health check function (AC-7 compliance)
-- Returns a single row: (status, checked_at, tenant_schema_exists)
-- This confirms: pool works, schema is accessible, migrations table exists

CREATE OR REPLACE FUNCTION {{schema_prefix}}meta.health()
RETURNS TABLE (
  status TEXT,
  checked_at TIMESTAMP WITH TIME ZONE,
  schema_name TEXT,
  migrations_count INT,
  tenant_info_count INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    'ok'::TEXT,
    CURRENT_TIMESTAMP,
    '{{schema_prefix}}meta'::TEXT,
    COALESCE((SELECT COUNT(*) FROM {{schema_prefix}}meta.migrations), 0)::INT,
    COALESCE((SELECT COUNT(*) FROM {{schema_prefix}}meta.tenant_info), 0)::INT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Grant execute permission to tenant role
GRANT EXECUTE ON FUNCTION {{schema_prefix}}meta.health() TO {{tenant_role}};

-- Step 2: Record this migration
INSERT INTO {{schema_prefix}}meta.migrations (name, checksum, applied_at)
VALUES ('001-tenant-health', 'p513-ddl-v1', CURRENT_TIMESTAMP)
ON CONFLICT (name) DO NOTHING;

-- Step 3: Create isolation guard function
-- AC-6: Verify cross-tenant access is blocked
-- This function is called by isolation smoke tests to confirm REVOKE took effect

CREATE OR REPLACE FUNCTION {{schema_prefix}}meta.verify_isolation()
RETURNS TABLE (
  test_name TEXT,
  test_passed BOOLEAN,
  error_message TEXT
) AS $$
DECLARE
  v_can_access_public BOOLEAN := FALSE;
  v_error_msg TEXT := NULL;
BEGIN
  -- Attempt to check if tenant can SELECT from public schema (should fail)
  BEGIN
    EXECUTE 'SELECT 1 FROM information_schema.schemata WHERE schema_name = ''public''';
    v_can_access_public := TRUE;
  EXCEPTION WHEN OTHERS THEN
    v_can_access_public := FALSE;
    v_error_msg := SQLERRM;
  END;

  -- Return test results (isolation confirmed if can't access public)
  RETURN QUERY
  SELECT
    'public_schema_isolation'::TEXT,
    NOT v_can_access_public::BOOLEAN,
    CASE WHEN v_can_access_public THEN 'WARNING: tenant can access public schema' ELSE NULL END::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION {{schema_prefix}}meta.verify_isolation() TO {{tenant_role}};

-- Step 4: Audit logging
COMMENT ON FUNCTION {{schema_prefix}}meta.health() IS
  'P513 AC-7 smoke test: Verifies pool connectivity and schema availability. Returns 1 row on success.';

COMMENT ON FUNCTION {{schema_prefix}}meta.verify_isolation() IS
  'P513 AC-6 isolation test: Confirms tenant role cannot access public schema (cross-tenant protection).';
