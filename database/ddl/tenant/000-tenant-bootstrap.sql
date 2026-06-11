-- Tenant baseline. Applied once at project_create time to a brand-new tenant DB.
-- Schema prefix is substituted by the saga: ${SCHEMA_PREFIX} → audio_, song_, agenthive_, etc.
-- Slug is substituted: ${SLUG} → monkeyKing-audio, georgia-singer, etc.

-- Re-bootstrap protection: detect if this schema was already initialized with a different slug
DO $$
DECLARE
  v_existing_slug TEXT;
BEGIN
  -- Check if the schema exists
  IF EXISTS (
    SELECT 1 FROM information_schema.schemata
    WHERE schema_name = '${SCHEMA_PREFIX}meta'
  ) THEN
    -- Schema exists; check if tenant_info table exists
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = '${SCHEMA_PREFIX}meta' AND table_name = 'tenant_info'
    ) THEN
      -- Table exists; retrieve the stored slug
      SELECT v INTO v_existing_slug
      FROM ${SCHEMA_PREFIX}meta.tenant_info
      WHERE k = 'slug';

      -- Check for slug mismatch (re-bootstrap protection)
      IF v_existing_slug IS NOT NULL AND v_existing_slug != '${SLUG}' THEN
        RAISE EXCEPTION
          'Re-bootstrap protection: slug mismatch. Expected %, got %',
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

-- String interpolation for ${SLUG} is safe because P495 validates the slug against
-- the kebab-case regex before substitution: ^[a-z0-9]([a-z0-9\-]*[a-z0-9])?$
-- This prevents SQL injection even though we use string literal substitution.
INSERT INTO ${SCHEMA_PREFIX}meta.tenant_info (k, v) VALUES
  ('slug', '${SLUG}'),
  ('created_at', now()::text),
  ('schema_prefix', '${SCHEMA_PREFIX}'),
  ('bootstrap_version', '1')
ON CONFLICT (k) DO NOTHING;
