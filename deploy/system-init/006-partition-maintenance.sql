-- ============================================================
-- agentHive2 — 006-partition-maintenance.sql
-- Partition registry, maintenance functions, and cron integration
-- for time-series tables (agency.session, agency.msg, governance.decision,
-- governance.complianceCheck, governance.event, identity.auditAction).
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql, 002-agency.sql, 003-identity.sql, 004-governance.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- ACCEPTANCE CRITERIA (Design Specification)
-- ============================================================
-- AC1: Registry table seeded with 6 partitioned tables
--   Verify: SELECT COUNT(*) FROM core.partition_policy; returns 6
--   Tables: agency.session (365d), agency.msg (90d), governance.decision (NULL),
--           governance.complianceCheck (365d), governance.event (NULL),
--           identity.auditAction (NULL)
--
-- AC2: fn_partition_maintenance(12) creates 12 future monthly partitions
--   Verify: SELECT COUNT(*) FROM pg_inherits WHERE inhrelid = 'agency.session'::regclass;
--   Expected: 13 (12 future + 1 default)
--   Naming: <table>_y<YYYY>_m<MM> (e.g., session_y2026_m05)
--
-- AC3: Retention DROP works on past partitions (time-series decay)
--   Verify: Create partition >365 days old, run fn_partition_maintenance(12),
--           confirm partition is detached and dropped
--   Test: INSERT row with timestamp 2025-04-06, run maintenance, verify gone
--
-- AC4: Default partition check returns zero rows in healthy state
--   Verify: SELECT COUNT(*) FROM core.fn_check_default_partitions() WHERE row_count > 0;
--           returns 0 in steady state
--   Alarm: Tuple in _default triggers alarm (row_count > 0)
--
-- AC5: Partition naming follows yYYYY_mMM pattern consistently
--   Verify: SELECT partition_name FROM pg_inherits WHERE ... LIKE '%_y%_m%'
--           all 6 tables use consistent pattern across 12 months
--
-- AC6: Cron script exits 0 on success, 1 on alarm or error
--   Verify: Run scripts/cron/agenthive2-partition-maintenance.sh
--           Exit code 0 when healthy (no _default tuples)
--           Exit code 1 when alarm (default partition has data)

-- ============================================================
-- core.partition_policy — Registry of partitioned tables
-- ============================================================
CREATE TABLE IF NOT EXISTS core.partition_policy (
  id                    BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schema_name           TEXT         NOT NULL,
  table_name            TEXT         NOT NULL,
  partition_column      TEXT         NOT NULL DEFAULT 'created_at',
  partition_type        TEXT         NOT NULL DEFAULT 'RANGE' CHECK (partition_type IN ('RANGE','LIST','HASH')),
  retention_days        INTEGER,                            -- NULL means permanent (e.g., governance.decision)
  lookahead_months      INTEGER      NOT NULL DEFAULT 12,   -- months into future to create partitions
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (schema_name, table_name)
);

COMMENT ON TABLE core.partition_policy IS
  'Registry of partitioned tables. Controls forward partition creation and '
  'retention-based cleanup. retention_days=NULL means permanent (e.g., audit logs).';

-- ============================================================
-- Seed: Register 6 time-series tables with retention policy
-- ============================================================
INSERT INTO core.partition_policy (schema_name, table_name, partition_column, retention_days, lookahead_months, notes)
VALUES
  ('agency', 'session', 'created_at', 365, 12, 'Session lifecycle events; 1-year retention'),
  ('agency', 'msg', 'created_at', 90, 12, 'MCP messages; 3-month retention'),
  ('governance', 'decision', 'decided_at', NULL, 12, 'Audit-immutable gate decisions; permanent'),
  ('governance', 'complianceCheck', 'checked_at', 365, 12, 'Compliance assessments; 1-year retention'),
  ('governance', 'event', 'occurred_at', NULL, 12, 'System event stream; permanent'),
  ('identity', 'auditAction', 'occurred_at', NULL, 12, 'Identity audit log; permanent')
ON CONFLICT (schema_name, table_name) DO NOTHING;

-- ============================================================
-- core.fn_partition_maintenance — Create forward partitions & drop expired
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_partition_maintenance(
  p_lookahead_months INTEGER DEFAULT 12
)
RETURNS TABLE (
  table_qualified TEXT,
  action TEXT,
  partition_name TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_policy RECORD;
  v_now TIMESTAMPTZ := now() AT TIME ZONE 'UTC';
  v_year INT;
  v_month INT;
  v_partition_name TEXT;
  v_from_bound TIMESTAMPTZ;
  v_to_bound TIMESTAMPTZ;
  v_lookahead_end TIMESTAMPTZ;
  v_partition_exists BOOLEAN;
  v_old_partition RECORD;
  v_cutoff_date TIMESTAMPTZ;
BEGIN
  -- Phase 1: Create forward partitions (current month + lookahead_months)
  FOR v_policy IN
    SELECT * FROM core.partition_policy ORDER BY (schema_name, table_name)
  LOOP
    v_year := EXTRACT(YEAR FROM v_now)::INT;
    v_month := EXTRACT(MONTH FROM v_now)::INT;
    v_lookahead_end := v_now + (p_lookahead_months || ' months')::INTERVAL;

    -- Loop through months from now to (now + lookahead_months)
    WHILE (v_year || '-' || LPAD(v_month::text, 2, '0') || '-01')::DATE <= v_lookahead_end::DATE LOOP
      v_partition_name := v_policy.table_name || '_y' || v_year || '_m' || LPAD(v_month::text, 2, '0');
      v_from_bound := (v_year || '-' || LPAD(v_month::text, 2, '0') || '-01')::TIMESTAMPTZ AT TIME ZONE 'UTC';
      v_to_bound := (v_from_bound + '1 month'::INTERVAL)::TIMESTAMPTZ;

      -- Check if partition already exists
      v_partition_exists := EXISTS (
        SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = (
          SELECT oid FROM pg_namespace WHERE nspname = v_policy.schema_name
        )
      );

      IF NOT v_partition_exists THEN
        EXECUTE format(
          'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
          v_policy.schema_name, v_partition_name,
          v_policy.schema_name, v_policy.table_name,
          v_from_bound, v_to_bound
        );
        RETURN QUERY SELECT
          (v_policy.schema_name || '.' || v_policy.table_name)::TEXT,
          'CREATE'::TEXT,
          v_partition_name;
      END IF;

      -- Advance to next month
      v_month := v_month + 1;
      IF v_month > 12 THEN
        v_month := 1;
        v_year := v_year + 1;
      END IF;
    END LOOP;
  END LOOP;

  -- Phase 2: Drop old partitions per retention policy
  FOR v_policy IN
    SELECT * FROM core.partition_policy WHERE retention_days IS NOT NULL
    ORDER BY (schema_name, table_name)
  LOOP
    v_cutoff_date := v_now - (v_policy.retention_days || ' days')::INTERVAL;

    FOR v_old_partition IN
      SELECT
        c.relname AS partition_name,
        pg_get_expr(c.relpartbound, c.oid) AS partition_bound
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class parent ON i.inhparent = parent.oid
      WHERE parent.relname = v_policy.table_name
        AND parent.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = v_policy.schema_name)
        AND c.relname NOT LIKE '%default'
        AND pg_get_expr(c.relpartbound, c.oid) ~ 'TO'
    LOOP
      -- Extract upper bound from partition definition: 'FROM ... TO ('<upper>')' → parse <upper>
      IF v_old_partition.partition_bound ~ '''([^'']+)''' THEN
        v_to_bound := (substring(v_old_partition.partition_bound FROM '''([^'']+)'''))::TIMESTAMPTZ AT TIME ZONE 'UTC';
        IF v_to_bound <= v_cutoff_date THEN
          EXECUTE format(
            'ALTER TABLE %I.%I DETACH PARTITION %I.%I',
            v_policy.schema_name, v_policy.table_name,
            v_policy.schema_name, v_old_partition.partition_name
          );
          EXECUTE format('DROP TABLE %I.%I', v_policy.schema_name, v_old_partition.partition_name);
          RETURN QUERY SELECT
            (v_policy.schema_name || '.' || v_policy.table_name)::TEXT,
            'DROP'::TEXT,
            v_old_partition.partition_name;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION core.fn_partition_maintenance IS
  'Create forward monthly partitions (current month + p_lookahead_months) and drop '
  'old partitions exceeding retention_days. Returns TABLE(table_qualified, action, partition_name). '
  'Idempotent: only creates missing partitions, only drops expired partitions. '
  'Partition naming: <table>_y<YYYY>_m<MM> (e.g., session_y2026_m05).';

-- ============================================================
-- core.fn_check_default_partitions — Alarm if _default has tuples
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_check_default_partitions()
RETURNS TABLE (
  schema_name TEXT,
  table_name TEXT,
  default_partition_name TEXT,
  row_count BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_policy RECORD;
  v_default_partition TEXT;
  v_count BIGINT;
BEGIN
  FOR v_policy IN
    SELECT * FROM core.partition_policy ORDER BY (schema_name, table_name)
  LOOP
    -- Find actual default partition (case-insensitive match, handles naming quirks)
    SELECT c.relname INTO v_default_partition
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON i.inhparent = parent.oid
    WHERE parent.relname = v_policy.table_name
      AND parent.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = v_policy.schema_name)
      AND c.relname LIKE v_policy.table_name || '%default'
    LIMIT 1;

    IF v_default_partition IS NOT NULL THEN
      EXECUTE format(
        'SELECT COUNT(*) FROM %I.%I',
        v_policy.schema_name, v_default_partition
      ) INTO v_count;

      RETURN QUERY SELECT
        v_policy.schema_name,
        v_policy.table_name,
        v_default_partition,
        v_count;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION core.fn_check_default_partitions IS
  'Check if any _default partition contains tuples (alarm condition). '
  'Returns TABLE(schema_name, table_name, default_partition_name, row_count). '
  'Healthy state: all row_count = 0 (data properly distributed across month partitions). '
  'Alarm: any row_count > 0 indicates partition key mismatch or range boundary issue.';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.partition_policy TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.fn_partition_maintenance(INTEGER) TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.fn_check_default_partitions() TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_observability;
    GRANT SELECT ON core.partition_policy TO agenthive_observability;
    GRANT EXECUTE ON FUNCTION core.fn_partition_maintenance(INTEGER) TO agenthive_observability;
    GRANT EXECUTE ON FUNCTION core.fn_check_default_partitions() TO agenthive_observability;
  END IF;
END $$;
