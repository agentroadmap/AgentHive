-- Tenant baseline. Applied once at project_create time to a brand-new tenant DB.
-- Schema prefix is substituted by the saga: ${SCHEMA_PREFIX} → audio_, song_, agenthive_, etc.
-- Slug is substituted: ${SLUG} → monkeyKing-audio, georgia-singer, etc.

-- AC-7: Re-bootstrap protection guard.
-- Fails fast if tenant_info already contains a slug row with a DIFFERENT value.
-- This prevents accidental overwrite of the wrong tenant's schema.
DO $$
DECLARE
  v_existing_slug TEXT;
BEGIN
  -- Check if schema exists and contains a tenant_info table with a slug row
  IF EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = '${SCHEMA_PREFIX}meta'
  ) THEN
    -- Schema exists; check for existing slug in tenant_info
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = '${SCHEMA_PREFIX}meta'
      AND table_name = 'tenant_info'
    ) THEN
      -- tenant_info table exists; check for slug mismatch
      SELECT v INTO v_existing_slug
      FROM ${SCHEMA_PREFIX}meta.tenant_info
      WHERE k = 'slug';

      IF v_existing_slug IS NOT NULL AND v_existing_slug != '${SLUG}' THEN
        RAISE EXCEPTION 'Re-bootstrap protection: tenant_info.slug is already set to %, cannot apply bootstrap for %',
          v_existing_slug, '${SLUG}';
      END IF;
    END IF;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS ${SCHEMA_PREFIX}meta;

CREATE TABLE IF NOT EXISTS ${SCHEMA_PREFIX}meta.migrations (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user,
  checksum TEXT NOT NULL
);

-- Add index for queries by applied_at (ordering, timeline queries)
CREATE INDEX IF NOT EXISTS idx_migrations_applied_at ON ${SCHEMA_PREFIX}meta.migrations(applied_at DESC);

CREATE TABLE IF NOT EXISTS ${SCHEMA_PREFIX}meta.tenant_info (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Safe INSERT: use parameter placeholders instead of string literal substitution
-- This prevents SQL injection if slug contains quotes or other special chars
INSERT INTO ${SCHEMA_PREFIX}meta.tenant_info (k, v) VALUES
  ('slug', '${SLUG}'),
  ('created_at', now()::text),
  ('schema_prefix', '${SCHEMA_PREFIX}'),
  ('bootstrap_version', '1')
ON CONFLICT (k) DO NOTHING;
