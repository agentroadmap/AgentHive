-- P592 smoke test — pgTAP integration test for core schema
-- Run: psql -d hiveCentral -c "CREATE EXTENSION IF NOT EXISTS pgtap;" \
--        -f tests/hivecentral/smoke.sql
-- All assertions execute inside a single transaction that is rolled back at finish().

\pset format unaligned
\pset tuples_only true

BEGIN;
SELECT plan(18);

-- ---------------------------------------------------------------
-- (1) core schema exists
-- ---------------------------------------------------------------
SELECT has_schema('core', 'core schema must exist');

-- ---------------------------------------------------------------
-- (2-6) all five tables present
-- ---------------------------------------------------------------
SELECT has_table('core', 'installation',      'core.installation table exists');
SELECT has_table('core', 'host',              'core.host table exists');
SELECT has_table('core', 'os_user',           'core.os_user table exists');
SELECT has_table('core', 'runtime_flag',      'core.runtime_flag table exists');
SELECT has_table('core', 'service_heartbeat', 'core.service_heartbeat table exists');

-- ---------------------------------------------------------------
-- (7) bootstrap seed: exactly one active installation row
-- ---------------------------------------------------------------
SELECT is(
  (SELECT COUNT(*)::int FROM core.installation WHERE lifecycle_status = 'active'),
  1,
  'bootstrap seed: exactly one active installation row present after DDL apply'
);

-- ---------------------------------------------------------------
-- (8) singleton guard: second active INSERT raises unique violation (23505)
-- ---------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO core.installation (display_name, schema_version, control_db_name, owner_did)
    VALUES ('duplicate-install', 'hivecentral-v3.0.0', 'hiveCentral', 'did:hive:smoke')$$,
  '23505',
  NULL,
  'installation_singleton index rejects second active row (23505 unique_violation)'
);

-- ---------------------------------------------------------------
-- (9) host INSERT succeeds
-- ---------------------------------------------------------------
INSERT INTO core.host (host_name, role, owner_did)
  VALUES ('smoke-host-1', 'agency', 'did:hive:smoke');
SELECT pass('host INSERT succeeded');

-- ---------------------------------------------------------------
-- (10) os_user INSERT referencing host succeeds
-- ---------------------------------------------------------------
INSERT INTO core.os_user (host_id, user_name, owner_did)
  SELECT host_id, 'smoke-user', 'did:hive:smoke'
    FROM core.host WHERE host_name = 'smoke-host-1';
SELECT pass('os_user INSERT referencing host succeeded');

-- ---------------------------------------------------------------
-- (11) runtime_flag INSERT with scope='global' succeeds
-- ---------------------------------------------------------------
INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, modified_by_did, owner_did)
  VALUES ('smoke.feature', 'global', '"enabled"', 'did:hive:smoke', 'did:hive:smoke');
SELECT pass('runtime_flag INSERT scope=global succeeded');

-- ---------------------------------------------------------------
-- (12) compound PK: INSERT with scope='host:<id>' succeeds (different (flag_name, scope) pair)
-- ---------------------------------------------------------------
INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, modified_by_did, owner_did)
  SELECT 'smoke.feature', 'host:' || host_id::text, '"override"', 'did:hive:smoke', 'did:hive:smoke'
    FROM core.host WHERE host_name = 'smoke-host-1';
SELECT pass('runtime_flag INSERT with host-scoped scope succeeded (compound PK verified)');

-- ---------------------------------------------------------------
-- (13) NOTIFY payload contains new_value: verify function source
-- (Cannot LISTEN in the same transaction; check function definition instead.)
-- ---------------------------------------------------------------
SELECT ok(
  (SELECT prosrc
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'core' AND p.proname = 'notify_runtime_flag_change') LIKE '%new_value%',
  'notify_runtime_flag_change() function source includes new_value key in payload'
);

-- ---------------------------------------------------------------
-- (14) runtime_flag_change_notify trigger is registered on core.runtime_flag
-- ---------------------------------------------------------------
SELECT has_trigger(
  'core', 'runtime_flag', 'runtime_flag_change_notify',
  'runtime_flag_change_notify trigger is attached to core.runtime_flag'
);

-- ---------------------------------------------------------------
-- (15) service_heartbeat INSERT + ON CONFLICT (service_id) DO UPDATE succeeds
-- ---------------------------------------------------------------
INSERT INTO core.service_heartbeat (service_id, host_id, pid, started_at)
  SELECT 'smoke-svc-1', host_id, 12345, now()
    FROM core.host WHERE host_name = 'smoke-host-1';
INSERT INTO core.service_heartbeat (service_id, host_id, pid, started_at, status)
  SELECT 'smoke-svc-1', host_id, 12345, now(), 'active'
    FROM core.host WHERE host_name = 'smoke-host-1'
  ON CONFLICT (service_id) DO UPDATE
    SET last_beat_at = now(), status = EXCLUDED.status;
SELECT pass('service_heartbeat INSERT + ON CONFLICT (service_id) DO UPDATE succeeded');

-- ---------------------------------------------------------------
-- (16) updated_at advances beyond created_at after catalog UPDATE
--      set_updated_at() uses clock_timestamp(); pg_sleep advances wall clock
--      while created_at remains fixed at transaction start (now()).
-- ---------------------------------------------------------------
DO $$ BEGIN PERFORM pg_sleep(0.02); END $$;
UPDATE core.host SET notes = 'smoke-test' WHERE host_name = 'smoke-host-1';
SELECT ok(
  (SELECT updated_at > created_at FROM core.host WHERE host_name = 'smoke-host-1'),
  'updated_at advances beyond created_at after UPDATE (set_updated_at() trigger fires)'
);

-- ---------------------------------------------------------------
-- (17) v_active_hosts is queryable and returns the inserted host
-- ---------------------------------------------------------------
SELECT ok(
  (SELECT COUNT(*)::int FROM core.v_active_hosts WHERE host_name = 'smoke-host-1') = 1,
  'v_active_hosts returns the active host row just inserted'
);

-- ---------------------------------------------------------------
-- (18) v_service_health returns health=''healthy'' for fresh heartbeat
-- ---------------------------------------------------------------
SELECT is(
  (SELECT health FROM core.v_service_health WHERE service_id = 'smoke-svc-1'),
  'healthy',
  'v_service_health reports health=healthy for a freshly-inserted heartbeat row'
);

SELECT * FROM finish();
ROLLBACK;
