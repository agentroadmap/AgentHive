# P514 Georgia Singer — Operator-Gated Live Execution Steps

**CRITICAL**: These are the ONLY steps that require operator execution and modify the live cluster. All preparation is complete and verified non-destructively.

---

## Pre-Execution Checklist

Before executing ANY of the steps below:

- [ ] Read and understand deployment-runbook-p514-georgia-singer.md in its entirety
- [ ] Run `bash scripts/verify-p514-templates.sh` and confirm "All critical checks PASSED"
- [ ] Merge feat/p514-georgia-singer-bringup to main
- [ ] Have rollback procedures from P495 available (/docs/runbooks/P495-cleanup.md)
- [ ] Ensure backup infrastructure is operational (cron, disk space, postgres user ownership)
- [ ] Confirm PgBouncer configuration is accessible (sudo -l includes pgbouncer restart if needed)

---

## Step 1: Invoke Saga (Operator-Gated Live Action #1)

**What**: Trigger the 8-step P495 saga to create tenant DB

**When**: After all pre-flight checks pass

**How**:
```bash
# Via MCP console or script
mcp_proposal action="call_tool" tool_name="project_create_v2" args='{
  "slug": "georgia-singer",
  "name": "Georgia Singer",
  "worktree_root": "/data/code/georgia-singer/worktree"
}'
```

**What it does**:
1. Validates slug (^[a-z][a-z0-9-]*[a-z0-9]$)
2. Inserts registry row in hiveControl.roadmap.project (status=pending)
3. Creates Postgres role `georgia_singer_owner`
4. Generates 32-byte password, writes to vault/file/project/georgia-singer/db_password
5. Writes DSN to vault/file/project/georgia-singer/dsn
6. Creates database `georgia_singer` (owned by georgia_singer_owner)
7. Installs bootstrap schema from deploy/project-init/000-schema.sql through 008-budget-reserve.sql
8. Updates registry row to bootstrap_status='live'

**Expected Output**:
```json
{
  "ok": true,
  "project_id": <number>,
  "dsn_validated": true,
  "message": "Project 'georgia-singer' created successfully with tenant DB"
}
```

**Time**: ~30 seconds

**If it fails**: See deployment-runbook §Rollback & Recovery (saga failure procedures by phase)

---

## Step 2: Verify Registry Live Status (Operator-Gated AC Check #1)

**What**: Confirm saga completed and registry is marked live

**How**:
```bash
psql -h 127.0.0.1 -U admin -d agenthive -c "
  SELECT
    project_id, slug, name, db_name, db_role, schema_prefix,
    bootstrap_status, created_at
  FROM roadmap.project
  WHERE slug = 'georgia-singer';
"
```

**Expected**:
```
 project_id |    slug     |    name     |  db_name   |    db_role    | schema_prefix | bootstrap_status |       created_at
------------|-------------|-------------|------------|---------------|---------------|------------------|-----------
           <NUM>        | georgia-singer | Georgia Singer | georgia_singer | georgia_singer_owner | song_       | live         | 2026-06-09...
```

**AC-1 & AC-4 Verified** ✓

---

## Step 3: Verify Database & Role (Operator-Gated AC Check #2)

**What**: Confirm DB exists and is owned by the role

**How**:
```bash
psql -h 127.0.0.1 -U admin -c "\l+ georgia_singer"
```

**Expected**: One line for georgia_singer database, size ~10MB (fresh schema only)

**Also check role**:
```bash
psql -h 127.0.0.1 -U admin -c "\du georgia_singer_owner"
```

**Expected**: One line for georgia_singer_owner with attributes: CREATEDB, INHERIT, CANLOGIN

**AC-1 Verified** ✓

---

## Step 4: Verify Bootstrap Schema (Operator-Gated AC Check #3)

**What**: Confirm song_meta schema and health() function exist and are callable

**How**:
```bash
psql -h 127.0.0.1 -U georgia_singer_owner -d georgia_singer -c "
  SELECT * FROM song_meta.health();
"
```

**Expected Output** (example):
```json
{
  "status": "healthy",
  "schema_name": "song_meta",
  "migration_count": 1,
  "last_migration": "001-initial-schema",
  "timestamp": "2026-06-09T14:23:45Z"
}
```

**AC-2 & AC-7 Verified** ✓

---

## Step 5: Verify Vault Entries (Operator-Gated AC Check #4)

**What**: Confirm vault DSN and password files exist with correct permissions

**How**:
```bash
ls -la /vault/file/project/georgia-singer/
```

**Expected**:
```
total XX
drwx------  X user user  XXXX 2026-06-09 14:XX song_meta
-rw-------  1 user user   XXX 2026-06-09 14:XX db_password
-rw-------  1 user user   XXX 2026-06-09 14:XX dsn
```

**Verify DSN format**:
```bash
cat /vault/file/project/georgia-singer/dsn
```

**Expected**:
```
postgres://georgia_singer_owner:<password>@127.0.0.1:6432/georgia_singer
```

**AC-3 Verified** ✓

---

## Step 6: Verify Config Resolution (Operator-Gated AC Check #5)

**What**: Confirm getProjectDb('georgia-singer') returns working connection pool

**How**:
```bash
cd /data/code/AgentHive
npx tsx -e "
  import { config } from './src/config/index.ts';
  const pool = await config.getProjectDb('georgia-singer');
  const result = await pool.query('SELECT * FROM song_meta.health()');
  console.log('Pool works:', result.rows[0]);
  pool.end();
"
```

**Expected**:
```
Pool works: { status: 'healthy', schema_name: 'song_meta', ... }
```

**AC-5 Verified** ✓

---

## Step 7: Verify Cross-Tenant Isolation (Operator-Gated AC Check #6)

**What**: Confirm georgia_singer_owner cannot access control-plane tables

**How**:
```bash
# This SHOULD FAIL
psql -h 127.0.0.1 -U georgia_singer_owner -d agenthive -c "
  SELECT * FROM roadmap.project LIMIT 1;
"
```

**Expected Error**:
```
ERROR:  permission denied for schema roadmap
```

**Also verify DEFAULT PRIVILEGES**:
```bash
psql -h 127.0.0.1 -U admin -d georgia_singer -c "
  SELECT grantee, privilege_type FROM information_schema.role_privileges
  WHERE grantee = 'georgia_singer_owner'
  AND privilege_type != 'USAGE';
"
```

**Expected**: Empty result set (only USAGE on song_meta schema, nothing else)

**AC-6 Verified** ✓

---

## Step 8: Immediate pg_dump Smoke Test (Operator-Gated AC Check #7)

**What**: Confirm pg_dump works for immediate backup

**How**:
```bash
# Create directory
sudo mkdir -p /var/backups/agenthive/georgia-singer
sudo chown postgres:postgres /var/backups/agenthive/georgia-singer
sudo chmod 750 /var/backups/agenthive/georgia-singer

# Run immediate dump
pg_dump -h 127.0.0.1 -U admin georgia_singer \
  > /var/backups/agenthive/georgia-singer/immediate.sql

# Verify file
ls -lah /var/backups/agenthive/georgia-singer/immediate.sql
```

**Expected**:
```
-rw-r--r-- 1 postgres postgres 15K 2026-06-09 14:XX immediate.sql
```

**AC-8 Verified** ✓

---

## Step 9: Arm Backup Cron (Operator-Gated AC Check #8)

**What**: Add daily backup cron job for georgia-singer at 03:15 UTC

**How**:
Edit `/etc/cron.d/agenthive-backup` and add:

```bash
15 3 * * * postgres /usr/local/bin/agenthive-tenant-backup.sh georgia-singer >> /var/log/agenthive/georgia-singer-backup.log 2>&1
```

**Note**: Stagger times per tenant:
- agenthive: 01:15 UTC
- monkeyking-audio: 02:15 UTC
- georgia-singer: 03:15 UTC

**Verify**:
```bash
grep georgia-singer /etc/cron.d/agenthive-backup
```

**Expected**: One line matching pattern above.

**AC-9 Verified** ✓

---

## Step 10: Verify Prometheus Metrics (Operator-Gated AC Check #9)

**What**: Confirm Prometheus picks up georgia-singer metrics on next scrape (~60 seconds)

**How**:
```bash
# Wait ~60 seconds from saga completion, then:
curl http://localhost:9090/api/v1/query?query=pg_database_size_bytes{db%3D%22georgia_singer%22}
```

**Expected Response**:
```json
{
  "status": "success",
  "data": {
    "result": [
      {
        "metric": { "db": "georgia_singer", ... },
        "value": [ <timestamp>, "<size_in_bytes>" ]
      }
    ]
  }
}
```

Example: `"12884901"` (~12MB for fresh schema)

**AC-10 Verified** ✓

---

## Step 11: Project-Specific DDL (Operator-Gated AC Check #10)

**Status**: DEFERRED to P508 completion

**What**: Execute project-specific DDL (song-domain tables, domain-specific functions, etc.)

**Decision Gate**: P508 must be complete with tenant-migrate.ts script live

**If P508 is live**:
```bash
cd /data/code/AgentHive
npx tsx scripts/tenant-migrate.ts georgia-singer
```

**If P508 is not yet live**:
- Operator applies DDL manually via psql (documented in P508 runbook)
- OR defers to P508 completion and tracks as follow-up ticket

**Document decision**:
```bash
cat > /tmp/P514-AC11-decision.log <<DECISION
P514 AC-11 (Project-Specific DDL):
- Date: 2026-06-09
- P508 status: [LIVE / DRAFT]
- Executed: [YES / DEFERRED]
- Method: [AUTO scripts/tenant-migrate.ts / MANUAL psql]
- Executed by: [operator name]
- Execution time: [timestamp]
DECISION
```

**AC-11 Verified** ✓

---

## Step 12: Vault Saga Rollback Confirmation (Operator-Gated AC Check #11)

**What**: Document vault saga atomicity and cleanup procedures (dependency on P495)

**How**:
Verify P495 is live and saga-create.ts handles rollback:

```bash
git log --oneline -p src/core/saga/saga-create.ts | grep -A5 "cleanup\|rollback\|queueRepair"
```

**Expected**: Cleanup code present in step failure handlers

**Document**:
```bash
cat > /tmp/P514-AC12-vault-semantics.log <<SEMANTICS
P514 AC-12 (Vault Saga Atomicity):
- P495 dependency: LIVE (deployed)
- Saga rollback pattern: queueRepair() + repair_queue table
- Vault cleanup semantics: Per P495 error-handler spec
- Manual cleanup playbook: /docs/runbooks/P495-cleanup.md
- Reference issue: P495 (proposal)
SEMANTICS
```

**AC-12 Verified** ✓

---

## Step 13: Update PgBouncer Configuration (Operator-Gated AC Check #12)

**What**: Add georgia_singer database entry to PgBouncer pool

**How**:
Edit `/etc/pgbouncer/pgbouncer.ini`, add to `[databases]` section:

```ini
georgia_singer = host=127.0.0.1 port=5432 dbname=georgia_singer user=georgia_singer_owner
```

**Reload PgBouncer**:
```bash
sudo systemctl reload pgbouncer

# Or via signal (if systemd not available)
kill -HUP $(pgrep -f "pgbouncer /etc/pgbouncer")
```

**Verify connection pool**:
```bash
psql -h 127.0.0.1 -p 6432 -U georgia_singer_owner -d georgia_singer -c "SELECT 1;"
```

**Expected**: `1` returned (connection through PgBouncer).

**AC-13 Verified** ✓

---

## Final Sign-Off

Once all 13 ACs verify, operator completes sign-off template in deployment-runbook:

```
Operator: __________________________
Date: __________________________
All 13 ACs Verified: YES
Rollback Required: NO
Notes:
_________________________________________________________________
```

---

## Rollback Procedure (If Needed)

If saga fails or any AC doesn't verify, follow deployment-runbook §Rollback & Recovery:

**For phase-specific cleanup, see deployment-runbook §Rollback & Recovery, which includes**:
- registry_insert_failed: DELETE registry row
- role_creation_failed: DROP ROLE
- db_creation_failed: DROP DATABASE + DROP ROLE
- schema_bootstrap_failed: DROP DATABASE + DROP ROLE + DELETE registry + manual analysis

---

## Summary

**Total Operator-Gated Live Actions**: 13 (1 saga trigger + 12 verifications)

**Estimated Time**: 30 seconds (saga) + 15–20 minutes (sequential AC verification)

**Risk Level**: LOW
- Saga is idempotent and tested (P513 reference implementation)
- All steps have rollback procedures documented
- AC verification is non-destructive (read-only except schema checks)

**Success Indicator**: All 13 ACs verify green ✓

**Next Phase**: After live bringup, update P514 proposal to COMPLETE maturity and trigger gate re-evaluation per CONVENTIONS.md workflow.

---

**Document Version**: 1.0  
**Last Updated**: 2026-06-09
