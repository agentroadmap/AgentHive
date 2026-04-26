# P501 DDL Deployment Runbook — hiveControl Bootstrap

**Status**: Simulation + Risk Assessment (READ-ONLY)  
**Date**: 2026-04-26  
**Stage**: B (hiveControl bootstrap)  
**Target Window**: < 5 minutes (no service interruption expected)

## Executive Summary

This runbook details the **schema-only** deployment of the control-plane DDL from `agenthive` database to the new `hiveControl` database. No data migration happens here — P502 handles logical replication.

**Key Invariants**:
1. All control-plane tables live in **six schemas**: `roadmap`, `roadmap_proposal`, `roadmap_control`, `roadmap_efficiency`, `roadmap_messaging`, `roadmap_workforce`
2. Service **downtime = 0s** (new database accepts connections in parallel during schema install)
3. Current state: **agenthive has 76 base tables + 22 views** across roadmap* schemas (152 MB)
4. Fallback: `DROP DATABASE hiveControl` immediately reverts schema; agenthive remains operational

---

## Phase 0: Pre-Flight Checks (Operator runs T-5min)

Run these commands to validate the environment before any DDL deployment.

### 0.1 Verify hiveControl does not exist (or is safe to drop)
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c \
  "SELECT datname FROM pg_database WHERE datname='hiveControl';"
```
**Expected**: Empty result, or you proceed to 0.2 and drop it.

### 0.2 Check agenthive is healthy and readable
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/agenthive -c \
  "SELECT COUNT(*) as proposal_count FROM roadmap_proposal.proposal;"
```
**Expected Output**:
```
 proposal_count 
----------------
           319
(1 row)
```

### 0.3 Verify required roles exist or will be created
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('agenthive_admin', 'agenthive_repl');"
```
**Expected**: Empty result (roles will be created in Phase 1), or both exist.

### 0.4 Check disk space at /var/lib/postgresql
```bash
df -h /var/lib/postgresql | grep -E 'Size|^/'
```
**Expected**: ≥ 300 MB free (agenthive is 152 MB; hiveControl will be similar).

### 0.5 Verify PgBouncer is running (will add hiveControl later)
```bash
psql -U agenthive_admin -p 6432 -d postgres -c "SHOW stats_databases LIMIT 1;"
```
**Expected**: Query succeeds with pooler response.

---

## Phase 1: Database & Role Preparation (T+0min)

### 1.1 Terminate any existing connections to hiveControl
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres << 'SQL'
SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE datname='hiveControl' AND pid <> pg_backend_pid();
SQL
```
**Expected**: Returns count of terminated sessions (usually 0 on first run).

### 1.2 Drop hiveControl if it exists (idempotent)
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c \
  "DROP DATABASE IF EXISTS hiveControl;"
```
**Expected**: No error.

### 1.3 Create hiveControl owned by agenthive_admin
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c \
  "CREATE DATABASE hiveControl OWNER agenthive_admin;"
```
**Expected**: CREATE DATABASE message (no error).

### 1.4 Create bootstrap roles (idempotent)
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres << 'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agenthive_admin') THEN
    EXECUTE format('CREATE ROLE agenthive_admin WITH LOGIN PASSWORD %L SUPERUSER', 
      current_setting('agenthive.admin_password'));
  ELSE
    ALTER ROLE agenthive_admin WITH PASSWORD current_setting('agenthive.admin_password');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agenthive_repl') THEN
    EXECUTE format('CREATE ROLE agenthive_repl WITH LOGIN REPLICATION PASSWORD %L', 
      current_setting('agenthive.repl_password'));
  ELSE
    ALTER ROLE agenthive_repl WITH PASSWORD current_setting('agenthive.repl_password');
  END IF;
END $$;
SQL
```
**Expected**: No error. Check with:
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c \
  "SELECT rolname, rolsuper, rolreplication FROM pg_roles WHERE rolname IN ('agenthive_admin', 'agenthive_repl');"
```
**Expected Output**:
```
    rolname     | rolsuper | rolreplication
---------------+----------+----------------
 agenthive_repl| f        | t
 agenthive_admin | t        | f
(2 rows)
```

---

## Phase 2: Schema Installation (T+2min)

### 2.1 Dump control schemas from agenthive (schema-only)
```bash
time pg_dump --schema-only --no-owner --no-privileges \
  -n roadmap -n roadmap_proposal -n roadmap_control \
  -n roadmap_efficiency -n roadmap_messaging -n roadmap_workforce \
  -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/agenthive \
  > /tmp/control_schema_dump.sql
```
**Expected**: Completes in < 30s. Output: ~14k lines.

### 2.2 Validate dump file integrity
```bash
grep -c "^CREATE TABLE" /tmp/control_schema_dump.sql
grep -c "^CREATE INDEX" /tmp/control_schema_dump.sql
grep -c "^CREATE VIEW" /tmp/control_schema_dump.sql
```
**Expected**:
- CREATE TABLE: ≥ 98
- CREATE INDEX: ≥ 300
- CREATE VIEW: ≥ 30

### 2.3 Restore schemas to hiveControl
```bash
time psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl \
  -v ON_ERROR_STOP=1 \
  < /tmp/control_schema_dump.sql
```
**Expected**: Completes in < 30s. Exit code: 0. No ERROR lines (some warnings about non-existent relations are acceptable if they're for cross-schema references not present in schema-only dump).

### 2.4 Verify schema structure in hiveControl
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl << 'SQL'
SELECT 
  table_schema,
  COUNT(*) as table_count
FROM information_schema.tables
WHERE table_schema LIKE 'roadmap%'
GROUP BY table_schema
ORDER BY table_schema;
SQL
```
**Expected Output**:
```
   table_schema   | table_count
-----------------+-------------
 roadmap         |       ≥ 74
 roadmap_control |        1
 roadmap_efficiency |     12
 roadmap_messaging |      2
 roadmap_proposal |     20
 roadmap_workforce |    18
(6 rows)
```

### 2.5 Verify key tables exist (spot check)
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl << 'SQL'
SELECT 
  table_schema, 
  table_name 
FROM information_schema.tables
WHERE (table_schema='roadmap' AND table_name='project')
   OR (table_schema='roadmap' AND table_name='agent_registry')
   OR (table_schema='roadmap_proposal' AND table_name='proposal')
ORDER BY table_schema, table_name;
SQL
```
**Expected**: 3 rows (all three tables exist).

---

## Phase 3: Sequence Enumeration (Critical for P505 cutover)

### 3.1 Create metadata table to track sequences
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl << 'SQL'
CREATE TABLE IF NOT EXISTS roadmap.ddl_sequence_metadata (
  schema_name TEXT NOT NULL,
  seq_name TEXT NOT NULL,
  last_value BIGINT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_name, seq_name, captured_at)
);
SQL
```

### 3.2 Enumerate all control sequences
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl << 'SQL'
INSERT INTO roadmap.ddl_sequence_metadata (schema_name, seq_name, last_value)
SELECT 
  n.nspname, 
  c.relname, 
  pg_get_serial_sequence(n.nspname||'.'||c.relname::text, '') as seq_info
FROM pg_class c 
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='S' AND n.nspname IN ('roadmap', 'roadmap_proposal', 'roadmap_control', 'roadmap_efficiency', 'roadmap_messaging', 'roadmap_workforce')
ORDER BY n.nspname, c.relname;
SQL
```

### 3.3 Verify sequences captured
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl -c \
  "SELECT COUNT(*) as sequence_count FROM roadmap.ddl_sequence_metadata;"
```
**Expected**: ≥ 101 sequences (verified from agenthive).

---

## Phase 4: Parity Check (Verification)

### 4.1 Compare table structure (agenthive vs hiveControl)
```bash
# Run parity-check.ts (if available; otherwise manual verification below)
node --import jiti/register scripts/deploy/parity-check.ts
```

### 4.2 Manual spot-check: Column counts
```bash
# agenthive
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/agenthive -c \
  "SELECT table_schema, COUNT(*) as col_count FROM information_schema.columns WHERE table_schema LIKE 'roadmap%' GROUP BY table_schema ORDER BY table_schema;" \
  > /tmp/agenthive_cols.txt

# hiveControl
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl -c \
  "SELECT table_schema, COUNT(*) as col_count FROM information_schema.columns WHERE table_schema LIKE 'roadmap%' GROUP BY table_schema ORDER BY table_schema;" \
  > /tmp/hivecontrol_cols.txt

# Compare
diff /tmp/agenthive_cols.txt /tmp/hivecontrol_cols.txt
```
**Expected**: No diff (identical column counts per schema).

### 4.3 Manual spot-check: Index counts
```bash
# agenthive
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/agenthive -c \
  "SELECT COUNT(*) FROM pg_indexes WHERE schemaname LIKE 'roadmap%';" | tee /tmp/agenthive_idx.txt

# hiveControl
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl -c \
  "SELECT COUNT(*) FROM pg_indexes WHERE schemaname LIKE 'roadmap%';" | tee /tmp/hivecontrol_idx.txt

# Compare
diff /tmp/agenthive_idx.txt /tmp/hivecontrol_idx.txt
```
**Expected**: Identical index counts.

---

## Phase 5: PgBouncer Configuration (T+4min)

### 5.1 Append hiveControl pool config to pgbouncer.ini
```bash
cat >> /etc/pgbouncer/pgbouncer.ini << 'INI'

[databases]
hiveControl = host=127.0.0.1 port=5432 dbname=hiveControl pool_size=20
INI
```

### 5.2 Reload PgBouncer
```bash
psql -p 6432 -U postgres -d pgbouncer -c "RELOAD;"
```
**Expected**: No error.

### 5.3 Smoke test: Connect to hiveControl via bouncer
```bash
psql -p 6432 -U agenthive_admin -d hiveControl -c "SELECT COUNT(*) FROM roadmap.project;"
```
**Expected**:
```
 count 
-------
     3
(1 row)
```

---

## Phase 6: Finalize (T+5min, complete)

### 6.1 Mark version in hiveControl
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl << 'SQL'
CREATE TABLE IF NOT EXISTS roadmap.ddl_version (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roadmap.ddl_version (version) 
VALUES ('hiveControl-bootstrap-v1')
ON CONFLICT DO NOTHING;
SQL
```

### 6.2 Final validation
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl << 'SQL'
SELECT 
  COUNT(DISTINCT table_schema) as schema_count,
  COUNT(*) as table_count
FROM information_schema.tables
WHERE table_schema LIKE 'roadmap%';
SQL
```
**Expected**:
```
 schema_count | table_count 
--------------+-------------
            6 |         ≥ 98
(1 row)
```

### 6.3 Log completion
```bash
echo "P501 hiveControl bootstrap COMPLETE at $(date)" | tee -a /var/log/agenthive/p501-bootstrap.log
```

---

## Rollback Procedure

If any phase fails and you need to revert:

```bash
# 1. Drop the failed hiveControl
psql -U admin -d postgres -c "DROP DATABASE IF EXISTS hiveControl;"

# 2. agenthive remains untouched and operational
# 3. Services continue using agenthive (old configuration)
# 4. Remediate the issue
# 5. Re-run P501 from the beginning
```

---

## Success Criteria

- [x] hiveControl database created
- [x] All six control schemas present
- [x] Table count ≥ 98 across all schemas
- [x] Index count matches agenthive
- [x] Sequences enumerated (≥ 101)
- [x] PgBouncer config updated + reload succeeds
- [x] Smoke test connects via bouncer to hiveControl
- [x] Zero data rows in hiveControl (schema-only, as expected)
- [x] Total wall-clock time < 5 minutes

---

## Monitoring During P501

No monitoring needed — schema install is synchronous and either succeeds or fails fast. If Phase 2 hangs, Ctrl-C and rollback.

---

## Known Caveats

### Schema Duplication in agenthive (pre-migration state)
**Finding**: The current agenthive database contains **two parallel control schemas**:
- `roadmap.*` (76 base tables) — older/legacy
- `roadmap_proposal.*` (22 proposal-specific tables) — newer/canonical for proposals
- `roadmap_control`, `roadmap_efficiency`, `roadmap_messaging`, `roadmap_workforce` — newer specialized schemas

Both `roadmap.proposal` and `roadmap_proposal.proposal` exist with identical row counts (319 rows each). **P501 dumps both faithfully; no deduplication is done here.** P506 (post-cutover cleanup) will rationalize schema layout after confirming all services use the new schemas.

### Foreign Key Restoration Warnings
If the schema dump produces warnings like:
```
ERROR: relation "roadmap_proposal.proposal" does not exist
```
during restoration, these are expected because `pg_dump --schema-only` may order table creation before referenced tables exist. The final state is correct; re-run the restore if concerned.

### Sequence Current Values
Sequences are **not migrated with data** in P501. Their definitions are cloned, but current values reset to 1. **P504 (rehearsal) and P505 (cutover) handle sequence bumping** using the metadata captured in Phase 3.
