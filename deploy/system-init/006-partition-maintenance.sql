-- ============================================================
-- agentHive2 — 006-partition-maintenance.sql
-- Partition maintenance function and cron scheduling for
-- time-series tables with automatic lifecycle (create + drop).
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql
-- P894 — partition maintenance function and cron for agentHive2
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- core.partition_policy — Policy registry for partitioned tables
-- ============================================================
CREATE TABLE IF NOT EXISTS core.partition_policy (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schema_name     TEXT NOT NULL,
    table_name      TEXT NOT NULL,
    partition_col   TEXT NOT NULL,
    interval_type   TEXT NOT NULL DEFAULT 'monthly' CHECK (interval_type IN ('daily','monthly')),
    lookahead_months INT NOT NULL DEFAULT 12,
    retention_days  INT,  -- NULL = keep forever
    is_active       BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (schema_name, table_name)
);

COMMENT ON TABLE core.partition_policy IS
    'Registry of partitioned tables and their maintenance policies. '
    'Controls which tables get partitions created and when old partitions expire. '
    'retention_days = NULL means permanent retention.';

COMMENT ON COLUMN core.partition_policy.lookahead_months IS
    'Number of monthly partitions to pre-create ahead of current date.';

-- Seed the 6 known partitioned tables
INSERT INTO core.partition_policy (schema_name, table_name, partition_col, interval_type, lookahead_months, retention_days)
VALUES
    ('agency',      'session',           'started_at',   'monthly', 12, 365),
    ('agency',      'msg',               'sent_at',      'monthly', 12, 90),
    ('governance',  'decision',          'decided_at',   'monthly', 12, NULL),
    ('governance',  'compliancecheck',   'checked_at',   'monthly', 12, 365),
    ('governance',  'event',             'occurred_at',  'monthly', 12, NULL),
    ('identity',    'auditaction',       'occurred_at',  'monthly', 12, NULL)
ON CONFLICT (schema_name, table_name) DO NOTHING;

COMMENT ON TABLE core.partition_policy IS
    'Seeded with 6 partitioned tables from agentHive2 baseline schema.';

-- ============================================================
-- core.fn_partition_maintenance — Main maintenance function
-- Creates forward partitions and drops expired ones per policy
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_partition_maintenance(
    p_lookahead_months INT DEFAULT 12
)
RETURNS TABLE (
    action          TEXT,
    schema_name     TEXT,
    table_name      TEXT,
    partition_name  TEXT,
    partition_range TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_policy        RECORD;
    v_month_start   DATE;
    v_month_end     DATE;
    v_part_name     TEXT;
    v_parent        TEXT;
    v_sql           TEXT;
    v_i             INT;
    v_drop_before   DATE;
    v_existing      BOOLEAN;
BEGIN
    FOR v_policy IN
        SELECT * FROM core.partition_policy WHERE is_active = true
    LOOP
        v_parent := quote_ident(v_policy.schema_name) || '.' || quote_ident(v_policy.table_name);

        -- Create forward monthly partitions
        FOR v_i IN 0 .. (p_lookahead_months - 1)
        LOOP
            v_month_start := date_trunc('month', CURRENT_DATE + (v_i || ' months')::INTERVAL)::DATE;
            v_month_end   := (v_month_start + INTERVAL '1 month')::DATE;
            v_part_name   := v_policy.table_name || '_'
                             || to_char(v_month_start, 'YYYY_MM');

            -- Check if partition already exists
            SELECT EXISTS (
                SELECT 1 FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = v_policy.schema_name
                  AND c.relname = v_part_name
            ) INTO v_existing;

            IF NOT v_existing THEN
                v_sql := format(
                    'CREATE TABLE IF NOT EXISTS %I.%I '
                    'PARTITION OF %s '
                    'FOR VALUES FROM (%L) TO (%L)',
                    v_policy.schema_name,
                    v_part_name,
                    v_parent,
                    v_month_start::TEXT,
                    v_month_end::TEXT
                );
                EXECUTE v_sql;

                action         := 'created';
                schema_name    := v_policy.schema_name;
                table_name     := v_policy.table_name;
                partition_name := v_part_name;
                partition_range := v_month_start::TEXT || ' .. ' || v_month_end::TEXT;
                RETURN NEXT;
            END IF;
        END LOOP;

        -- Drop expired partitions if retention_days is set
        IF v_policy.retention_days IS NOT NULL THEN
            v_drop_before := (CURRENT_DATE - (v_policy.retention_days || ' days')::INTERVAL)::DATE;
            v_drop_before := date_trunc('month', v_drop_before)::DATE;

            -- Find child partitions older than retention window
            FOR v_part_name IN
                SELECT c.relname
                FROM pg_inherits i
                JOIN pg_class p ON p.oid = i.inhparent
                JOIN pg_class c ON c.oid = i.inhrelid
                JOIN pg_namespace np ON np.oid = p.relnamespace
                JOIN pg_namespace nc ON nc.oid = c.relnamespace
                WHERE np.nspname = v_policy.schema_name
                  AND p.relname   = v_policy.table_name
                  AND nc.nspname  = v_policy.schema_name
                  AND c.relname  != v_policy.table_name || '_default'
                  -- Only drop month partitions older than cutoff
                  AND to_date(
                        right(c.relname, 7),  -- YYYY_MM suffix
                        'YYYY_MM'
                      ) < v_drop_before
            LOOP
                EXECUTE format('DROP TABLE IF EXISTS %I.%I', v_policy.schema_name, v_part_name);

                action         := 'dropped';
                schema_name    := v_policy.schema_name;
                table_name     := v_policy.table_name;
                partition_name := v_part_name;
                partition_range := 'expired';
                RETURN NEXT;
            END LOOP;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION core.fn_partition_maintenance(INT) IS
    'Automatic partition lifecycle: creates forward monthly partitions '
    'and drops expired ones per core.partition_policy. '
    'Idempotent — safe to call multiple times in one day. '
    'P894.';

-- ============================================================
-- core.fn_check_default_partitions — Health check
-- Reports tables where only the default partition exists
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_check_default_partitions()
RETURNS TABLE (
    schema_name     TEXT,
    table_name      TEXT,
    partition_count BIGINT,
    has_only_default BOOLEAN
)
LANGUAGE sql
AS $$
    SELECT
        np.nspname::TEXT AS schema_name,
        p.relname::TEXT  AS table_name,
        count(*)         AS partition_count,
        bool_and(c.relname = p.relname || '_default') AS has_only_default
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace np ON np.oid = p.relnamespace
    WHERE p.relkind = 'p'
    GROUP BY np.nspname, p.relname
    ORDER BY np.nspname, p.relname;
$$;

COMMENT ON FUNCTION core.fn_check_default_partitions() IS
    'Health check: returns partition counts per partitioned table. '
    'Flags tables with only the default partition (suggests maintenance not yet run).';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.partition_policy TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.fn_partition_maintenance(INT), core.fn_check_default_partitions() TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_observability;
    GRANT SELECT ON core.partition_policy TO agenthive_observability;
    GRANT EXECUTE ON FUNCTION core.fn_partition_maintenance(INT), core.fn_check_default_partitions() TO agenthive_observability;
  END IF;
END $$;
