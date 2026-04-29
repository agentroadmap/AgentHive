-- P676 rollback: tear down the new roles and restore admin's connection limit.
--
-- Pre-condition: ALL services restarted back to the `admin` env file.
-- Verify before running:
--   SELECT usename, count(*) FROM pg_stat_activity
--   WHERE usename IN ('roadmap_ro','roadmap_app','roadmap_admin')
--   GROUP BY usename;
--   -- Expected: 0 rows (no active service connections as the new roles).
--
-- Apply via:
--   PGPASSWORD=$ADMIN_PASS psql -h 127.0.0.1 -U admin -d agenthive \
--     -f scripts/migrations/067-p676-rollback.sql
--
-- Then run separately:
--   ALTER ROLE admin CONNECTION LIMIT -1;

\set ON_ERROR_STOP on

BEGIN;

-- Remove default-priv rules attached to roadmap_admin.
DO $$
DECLARE s text;
BEGIN
	FOREACH s IN ARRAY ARRAY[
		'roadmap','roadmap_proposal','roadmap_workforce','roadmap_efficiency',
		'roadmap_control','roadmap_messaging','metrics','token_cache'
	] LOOP
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'REVOKE SELECT ON TABLES FROM roadmap_ro', s);
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM roadmap_app', s);
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'REVOKE USAGE, SELECT ON SEQUENCES FROM roadmap_app', s);
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'REVOKE EXECUTE ON FUNCTIONS FROM roadmap_app', s);
	END LOOP;
END
$$;

-- Drop owned/granted objects so DROP ROLE will succeed.
REASSIGN OWNED BY roadmap_admin TO admin;
DROP OWNED BY roadmap_admin;
DROP OWNED BY roadmap_app;
DROP OWNED BY roadmap_ro;

DROP ROLE IF EXISTS roadmap_admin;
DROP ROLE IF EXISTS roadmap_app;
DROP ROLE IF EXISTS roadmap_ro;

COMMIT;

-- Post-commit:
--   ALTER ROLE admin CONNECTION LIMIT -1;
