-- P514: Georgia-Singer Bootstrap Schema Application
-- Applied to georgia_singer database
-- Substitutions: ${SCHEMA_PREFIX} → song_, ${SLUG} → georgia-singer
-- Date: 2026-06-12 (re-execution after recovery)

-- ============================================================================
-- 000-tenant-bootstrap.sql (with substitutions for georgia-singer)
-- ============================================================================

-- Re-bootstrap protection: detect if this schema was already initialized with a different slug
DO $$
DECLARE
  v_existing_slug TEXT;
BEGIN
  -- Check if the schema exists
  IF EXISTS (
    SELECT 1 FROM information_schema.schemata
    WHERE schema_name = 'song_meta'
  ) THEN
    -- Schema exists; check if tenant_info table exists
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'song_meta' AND table_name = 'tenant_info'
    ) THEN
      -- Table exists; retrieve the stored slug
      SELECT v INTO v_existing_slug
      FROM song_meta.tenant_info
      WHERE k = 'slug';

      -- Check for slug mismatch (re-bootstrap protection)
      IF v_existing_slug IS NOT NULL AND v_existing_slug != 'georgia-singer' THEN
        RAISE EXCEPTION
          'Re-bootstrap protection: slug mismatch. Expected %, got %',
          v_existing_slug, 'georgia-singer';
      END IF;
    END IF;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS song_meta;

CREATE TABLE IF NOT EXISTS song_meta.migrations (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user,
  checksum TEXT NOT NULL
);

-- Add index for queries by applied_at (ordering, timeline queries)
CREATE INDEX IF NOT EXISTS idx_migrations_applied_at ON song_meta.migrations(applied_at DESC);

CREATE TABLE IF NOT EXISTS song_meta.tenant_info (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- String interpolation is safe; slug validated by P495
INSERT INTO song_meta.tenant_info (k, v) VALUES
  ('slug', 'georgia-singer'),
  ('created_at', now()::text),
  ('schema_prefix', 'song_'),
  ('bootstrap_version', '1')
ON CONFLICT (k) DO NOTHING;

-- ============================================================================
-- 001-tenant-health.sql (with substitutions for georgia-singer)
-- ============================================================================

CREATE OR REPLACE FUNCTION song_meta.health()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_slug text;
  v_migrations int;
BEGIN
  SELECT v INTO v_slug FROM song_meta.tenant_info WHERE k = 'slug';
  SELECT count(*) INTO v_migrations FROM song_meta.migrations;

  RETURN jsonb_build_object(
    'ok', true,
    'slug', v_slug,
    'migrations_applied', v_migrations,
    'now', now()
  );
END;
$$;

-- ============================================================================
-- Verification
-- ============================================================================

SELECT 'Bootstrap complete. Schema georgia-singer:' as note;
SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'song_meta';

-- Test health function
SELECT 'Health check:' as note;
SELECT song_meta.health();

-- Verify tenant_info
SELECT 'Tenant info:' as note;
SELECT k, v FROM song_meta.tenant_info ORDER BY k;
