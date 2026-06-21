-- P4508 Phase 1b + Phase 2: seed tenant_db_url for live projects + backfill dsn_secret_ref
--
-- AC-4: set tenant_db_url for the two bootstrap_status='live' rows.
--   DSN is constructed from existing host/port/db_name columns using the admin role.
--   The password placeholder (PGPASSWORD) must be substituted by the operator, or this
--   migration can be run after setting app.admin_password via SET LOCAL.
--
-- AC-5: Phase-2 backfill — copy tenant_db_url → dsn_secret_ref for rows where
--   dsn_secret_ref IS NULL AND tenant_db_url IS NOT NULL.
--
-- NOTE: This migration also updates dsn_secret_ref for live projects to a direct
--   postgres:// DSN so that P4508 AC-3 (bridge returns postgres:// refs as-is)
--   makes getProjectDb() work without a vault backend.

DO $$
DECLARE
  v_password TEXT;
  v_dsn      TEXT;
  r          RECORD;
BEGIN
  -- Read the admin password from a session variable if set; otherwise fall back
  -- to the PGPASSWORD GUC (requires SET agenthive.admin_password = '...' before running).
  BEGIN
    v_password := current_setting('agenthive.admin_password');
  EXCEPTION WHEN undefined_object THEN
    v_password := NULL;
  END;

  -- For each live project that has all connection details, build and set tenant_db_url.
  FOR r IN
    SELECT project_id, slug, host, port, db_name
      FROM roadmap.project
     WHERE bootstrap_status = 'live'
       AND db_name IS NOT NULL
       AND host IS NOT NULL
       AND port IS NOT NULL
  LOOP
    IF v_password IS NOT NULL THEN
      v_dsn := format(
        'postgresql://admin:%s@%s:%s/%s',
        v_password,
        r.host,
        r.port,
        r.db_name
      );
    ELSE
      -- No password available: store a DSN template the operator must complete.
      -- The code will still fail to connect until a valid DSN is set.
      v_dsn := format(
        'postgresql://admin:REPLACE_WITH_PGPASSWORD@%s:%s/%s',
        r.host,
        r.port,
        r.db_name
      );
      RAISE WARNING 'P4508: agenthive.admin_password not set — storing DSN template for project "%". Set tenant_db_url manually or re-run with SET agenthive.admin_password = ''<password>'';', r.slug;
    END IF;

    UPDATE roadmap.project
       SET tenant_db_url  = v_dsn,
           -- Also update dsn_secret_ref to the direct postgres:// DSN so that
           -- P4508 AC-3 (bridge returns postgres:// refs as-is) works immediately,
           -- regardless of vault backend availability.
           dsn_secret_ref = v_dsn
     WHERE project_id = r.project_id;
  END LOOP;
END;
$$;

-- AC-5: Phase-2 backfill — copy tenant_db_url → dsn_secret_ref for rows where
-- dsn_secret_ref IS NULL AND tenant_db_url IS NOT NULL.
-- (Live project rows already updated above; this covers any other pending rows.)
UPDATE roadmap.project
   SET dsn_secret_ref = tenant_db_url
 WHERE dsn_secret_ref IS NULL
   AND tenant_db_url IS NOT NULL;
