/**
 * P513 / P508: Tenant Database Bootstrap Template
 *
 * Applied by saga-create.ts Step 6 after database creation.
 * Substitutions required:
 *   {{schema_prefix}} — e.g. 'audio_' for monkeyKing-audio
 *   {{tenant_role}} — e.g. 'monkeyKing_audio_owner'
 *
 * Creates tenant-owned schema infrastructure:
 * - {{schema_prefix}}meta.migrations (audit table)
 * - {{schema_prefix}}meta.tenant_info (tenant identity)
 * - Enforces role isolation: no public schema access for tenant role
 *
 * Idempotent: re-application with same schema_prefix is safe.
 * Applied by: monkeyKing_audio_owner role (post-creation via trusted admin path).
 */

-- Step 1: Create tenant-specific metadata schema
CREATE SCHEMA IF NOT EXISTS {{schema_prefix}}meta;

-- Step 2: Create migrations tracking table
CREATE TABLE IF NOT EXISTS {{schema_prefix}}meta.migrations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rolled_back_at TIMESTAMP WITH TIME ZONE
);

-- Step 3: Create tenant identity record
CREATE TABLE IF NOT EXISTS {{schema_prefix}}meta.tenant_info (
  id SERIAL PRIMARY KEY,
  tenant_name TEXT NOT NULL,
  schema_prefix TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  bootstrap_version TEXT DEFAULT '1.0'
);

-- Step 4: Insert this tenant's identity (idempotent via ON CONFLICT)
INSERT INTO {{schema_prefix}}meta.tenant_info (tenant_name, schema_prefix, bootstrap_version)
VALUES ('{{tenant_name}}', '{{schema_prefix}}', '1.0')
ON CONFLICT (schema_prefix) DO NOTHING;

-- Step 5: Record this script's application
INSERT INTO {{schema_prefix}}meta.migrations (name, checksum, applied_at)
VALUES ('000-tenant-bootstrap', 'p513-ddl-v1', CURRENT_TIMESTAMP)
ON CONFLICT (name) DO NOTHING;

-- Step 6: Role isolation — revoke all public schema access
-- CRITICAL AC-6: Tenant role must not read agenthive.roadmap
REVOKE ALL ON SCHEMA public FROM {{tenant_role}};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {{tenant_role}};

-- Step 7: Grant tenant role access to its own metadata schema
GRANT USAGE ON SCHEMA {{schema_prefix}}meta TO {{tenant_role}};
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA {{schema_prefix}}meta TO {{tenant_role}};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {{schema_prefix}}meta TO {{tenant_role}};

-- Step 8: Create audit view for operator observability (read-only for tenant)
CREATE OR REPLACE VIEW {{schema_prefix}}meta.audit_log AS
SELECT
  name,
  checksum,
  applied_at,
  rolled_back_at,
  CASE WHEN rolled_back_at IS NOT NULL THEN 'rolled_back' ELSE 'applied' END as status
FROM {{schema_prefix}}meta.migrations
ORDER BY applied_at DESC;

GRANT SELECT ON {{schema_prefix}}meta.audit_log TO {{tenant_role}};
