-- P676: Decompose PG superuser `admin` into capability-scoped roles.
--
-- Roles:
--   roadmap_ro     — SELECT + LISTEN; for state-feed, discord-bridge.       (rolconnlimit=30)
--   roadmap_app    — inherits roadmap_ro + DML + sequence USAGE; the workhorse role for
--                    board, mcp, orchestrator, gate-pipeline, claude-agency,
--                    copilot-agency, a2a, notification-router.              (rolconnlimit=80)
--   roadmap_admin  — DDL + role mgmt; humans and migrations only.           (rolconnlimit=5)
--
-- `admin` (PG superuser) is NOT dropped — kept as break-glass with rolconnlimit=5.
-- Existing legacy NOLOGIN group roles (agent_read, agent_write, admin_write,
-- roadmap_agent) are left untouched.
--
-- The bootstrap is idempotent. Passwords are read from psql variables (-v ...)
-- so they never land in commit history.
--
-- Apply via:
--   PGPASSWORD=$ADMIN_PASS psql -h 127.0.0.1 -U admin -d agenthive \
--     -v ro_pass=$RO_PASS -v app_pass=$APP_PASS -v admin_pass=$ADMIN_PASS \
--     -f scripts/migrations/067-p676-pg-role-decomposition.sql
--
-- After commit, run separately (cannot be inside transaction):
--   ALTER ROLE admin CONNECTION LIMIT 5;

\set ON_ERROR_STOP on

-- Validate that all three password variables were supplied (psql exits nonzero
-- if a referenced variable is unset and ON_ERROR_STOP is on).
\if :{?ro_pass}
\else
\warn 'Missing -v ro_pass'
\quit
\endif
\if :{?app_pass}
\else
\warn 'Missing -v app_pass'
\quit
\endif
\if :{?admin_pass}
\else
\warn 'Missing -v admin_pass'
\quit
\endif

BEGIN;

-- 1. Create roles using \gexec so we can substitute :'pass' values that are
--    NOT visible to a server-side DO block. \gexec runs each row of the prior
--    SELECT as a SQL statement. WHERE NOT EXISTS guards make it idempotent.

SELECT 'CREATE ROLE roadmap_ro LOGIN PASSWORD ' || quote_literal(:'ro_pass') || ' CONNECTION LIMIT 30'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_ro')
UNION ALL
SELECT 'ALTER ROLE roadmap_ro WITH LOGIN PASSWORD ' || quote_literal(:'ro_pass') || ' CONNECTION LIMIT 30'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_ro')
\gexec

SELECT 'CREATE ROLE roadmap_app LOGIN PASSWORD ' || quote_literal(:'app_pass') || ' CONNECTION LIMIT 80'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_app')
UNION ALL
SELECT 'ALTER ROLE roadmap_app WITH LOGIN PASSWORD ' || quote_literal(:'app_pass') || ' CONNECTION LIMIT 80'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_app')
\gexec

SELECT 'CREATE ROLE roadmap_admin LOGIN CREATEROLE PASSWORD ' || quote_literal(:'admin_pass') || ' CONNECTION LIMIT 5'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_admin')
UNION ALL
SELECT 'ALTER ROLE roadmap_admin WITH LOGIN CREATEROLE PASSWORD ' || quote_literal(:'admin_pass') || ' CONNECTION LIMIT 5'
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_admin')
\gexec

-- 2. roadmap_app inherits roadmap_ro (so SELECT + LISTEN come for free).
GRANT roadmap_ro TO roadmap_app;

-- 3. Schema USAGE for ro and app on all 8 active schemas.
GRANT USAGE ON SCHEMA roadmap            TO roadmap_ro, roadmap_app, roadmap_admin;
GRANT USAGE ON SCHEMA roadmap_proposal   TO roadmap_ro, roadmap_app, roadmap_admin;
GRANT USAGE ON SCHEMA roadmap_workforce  TO roadmap_ro, roadmap_app, roadmap_admin;
GRANT USAGE ON SCHEMA roadmap_efficiency TO roadmap_ro, roadmap_app, roadmap_admin;
GRANT USAGE ON SCHEMA roadmap_control    TO roadmap_ro, roadmap_app, roadmap_admin;
GRANT USAGE ON SCHEMA roadmap_messaging  TO roadmap_ro, roadmap_app, roadmap_admin;
GRANT USAGE ON SCHEMA metrics            TO roadmap_ro, roadmap_app, roadmap_admin;
GRANT USAGE ON SCHEMA token_cache        TO roadmap_ro, roadmap_app, roadmap_admin;

-- 4. CREATE on schemas for roadmap_admin so it can perform table DDL
--    (rolcreaterole=t alone only covers ROLE creation).
GRANT CREATE ON SCHEMA roadmap            TO roadmap_admin;
GRANT CREATE ON SCHEMA roadmap_proposal   TO roadmap_admin;
GRANT CREATE ON SCHEMA roadmap_workforce  TO roadmap_admin;
GRANT CREATE ON SCHEMA roadmap_efficiency TO roadmap_admin;
GRANT CREATE ON SCHEMA roadmap_control    TO roadmap_admin;
GRANT CREATE ON SCHEMA roadmap_messaging  TO roadmap_admin;
GRANT CREATE ON SCHEMA metrics            TO roadmap_admin;
GRANT CREATE ON SCHEMA token_cache        TO roadmap_admin;

-- 5. Existing tables: SELECT for ro, SELECT/INSERT/UPDATE/DELETE for app.
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap            TO roadmap_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_proposal   TO roadmap_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_workforce  TO roadmap_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_efficiency TO roadmap_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_control    TO roadmap_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_messaging  TO roadmap_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA metrics            TO roadmap_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA token_cache        TO roadmap_ro;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA roadmap            TO roadmap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA roadmap_proposal   TO roadmap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA roadmap_workforce  TO roadmap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA roadmap_efficiency TO roadmap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA roadmap_control    TO roadmap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA roadmap_messaging  TO roadmap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA metrics            TO roadmap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA token_cache        TO roadmap_app;

-- 6. Sequences: USAGE+SELECT for app on all 8 schemas (5 currently have sequences).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA roadmap            TO roadmap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA roadmap_proposal   TO roadmap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA roadmap_workforce  TO roadmap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA roadmap_efficiency TO roadmap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA roadmap_control    TO roadmap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA roadmap_messaging  TO roadmap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA metrics            TO roadmap_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA token_cache        TO roadmap_app;

-- 7. Functions: EXECUTE for app on schemas where functions exist.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA roadmap            TO roadmap_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA roadmap_proposal   TO roadmap_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA roadmap_workforce  TO roadmap_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA roadmap_efficiency TO roadmap_app;

-- 8. Default privileges for objects created by roadmap_admin going forward.
--    (Existing default-priv rules on `andy` are left in place for compat.)
DO $$
DECLARE s text;
BEGIN
	FOREACH s IN ARRAY ARRAY[
		'roadmap','roadmap_proposal','roadmap_workforce','roadmap_efficiency',
		'roadmap_control','roadmap_messaging','metrics','token_cache'
	] LOOP
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'GRANT SELECT ON TABLES TO roadmap_ro', s);
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO roadmap_app', s);
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'GRANT USAGE, SELECT ON SEQUENCES TO roadmap_app', s);
		EXECUTE format(
			'ALTER DEFAULT PRIVILEGES FOR ROLE roadmap_admin IN SCHEMA %I '
			'GRANT EXECUTE ON FUNCTIONS TO roadmap_app', s);
	END LOOP;
END
$$;

-- 9. Smoke tests inside the transaction. Anything thrown rolls back the migration.
DO $$
DECLARE smoke_count int;
BEGIN
	-- ro can read
	SET LOCAL ROLE roadmap_ro;
	SELECT count(*) INTO smoke_count FROM roadmap_proposal.proposal LIMIT 1;
	RAISE NOTICE 'smoke: roadmap_ro can SELECT roadmap_proposal.proposal (% rows visible)', smoke_count;
	RESET ROLE;

	-- app can read
	SET LOCAL ROLE roadmap_app;
	SELECT count(*) INTO smoke_count FROM roadmap_workforce.squad_dispatch LIMIT 1;
	RAISE NOTICE 'smoke: roadmap_app can SELECT roadmap_workforce.squad_dispatch';
	RESET ROLE;
END
$$;

COMMIT;

-- Post-commit (run separately, ALTER ROLE cannot be inside transaction):
--   ALTER ROLE admin CONNECTION LIMIT 5;

-- Verification queries — run after commit:
--   SELECT rolname, rolconnlimit, rolsuper, rolcreaterole, rolcanlogin
--   FROM pg_roles
--   WHERE rolname IN ('roadmap_ro','roadmap_app','roadmap_admin','admin')
--   ORDER BY rolname;
