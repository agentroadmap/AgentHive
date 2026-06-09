# P514 Georgia Singer Tenant DB Bringup — Operator Runbook

**Proposal**: P514 (Stage F2 of P429 multi-tenant topology)  
**Scope**: Provision `georgia-singer` as the third and final proof-of-concept tenant DB  
**Target DB Slug**: `georgia-singer`  
**Tenant DB Name**: `georgia_singer`  
**Tenant DB Role**: `georgia_singer_owner`  
**Schema Prefix**: `song_`  
**Vault DSN Path**: `vault://file/project/georgia-singer/dsn`  

---

## Overview

This runbook orchestrates the operator-executed bringup of the `georgia-singer` tenant database. It follows the **P495 Saga pattern** (8-step idempotent saga) and closely mirrors P513 (monkeyKing-audio), confirming that the multi-tenant architecture scales beyond two tenants.

The bringup consists of:

1. **Speculative Registry Insert** — Register the project in `hiveControl.roadmap.project`
2. **Postgres Role Creation** — Create `georgia_singer_owner` role
3. **Vault DSN Write** — Store DB credentials in vault
4. **Database Creation** — Create `georgia_singer` database
5. **Schema Bootstrap** — Install migration tracking and health tables
6. **Ops Bundle Setup** — Configure backup, monitoring, PgBouncer
7. **Tenant Isolation Verification** — Cross-tenant access controls
8. **Smoke Testing** — Validate connectivity and basic DDL

All steps are **idempotent** and can be safely retried.

---

## Acceptance Criteria Coverage

| AC# | Criterion | Verification Method |
|-----|-----------|---------------------|
| 1   | DB exists, owned by role | `\l+ georgia_singer` in psql |
| 2   | Bootstrap schema installed | `SELECT * FROM song_meta.health()` |
| 3   | Vault entries exist | `ls -la vault://file/project/georgia-singer/` |
| 4   | Registry live status | `SELECT bootstrap_status FROM roadmap.project WHERE slug='georgia-singer'` |
| 5   | getProjectDb() pool works | Node.js smoke test script |
| 6   | Cross-tenant isolation | Attempt SELECT on roadmap.project via georgia_singer_owner role |
| 7   | song_meta.health() callable | Node.js smoke test |
| 8   | pg_dump immediate smoke test | Check file at `/var/backups/agenthive/georgia-singer/immediate.sql` |
| 9   | Backup cron armed | Verify entry in `/etc/cron.d/agenthive-backup` |
| 10  | Prometheus metrics picked up | Scrape target check at next 60s interval |
| 11  | Project-specific DDL executed | Per P508; deferred if scripts/tenant-migrate.ts not yet live |
| 12  | Vault write rollback semantics | Verify cleanup playbook in P495 dependency |
| 13  | PgBouncer config updated | Check `georgia_singer` entry in `/etc/pgbouncer/pgbouncer.ini` |

---

## Step-by-Step Execution

### **Step 0: Pre-Flight Checks**

Before starting, confirm:

```bash
# Check hiveControl DB connectivity
psql -h 127.0.0.1 -U admin -d agenthive -c "SELECT slug, bootstrap_status FROM roadmap.project WHERE slug IN ('agenthive', 'monkeyking-audio');"

# Expected output: two rows with bootstrap_status='live'
```

If either shows `pending` or `failed`, repair that tenant first (see Rollback section).

### **Step 1: MCP-Triggered Saga (AUTOMATED)**

The operator invokes the MCP tool:

```bash
# Via MCP console or script
mcp_proposal action="call_tool" tool_name="project_create_v2" args='{
  "slug": "georgia-singer",
  "name": "Georgia Singer",
  "worktree_root": "/data/code/georgia-singer/worktree"
}'
```

This triggers **saga-create.ts**, which handles Steps 2–8 below:

- **Step 1 (Saga internal)**: Slug validation
- **Step 2**: Speculative registry insert → `project_id` assigned
- **Step 3**: Postgres role creation
- **Step 4**: Vault DSN write + readback
- **Step 5**: Database creation
- **Step 6**: Schema bootstrap
- **Step 7**: Ops bundle setup
- **Step 8**: Mark `bootstrap_status='live'`

**Expected output**:
```json
{
  "ok": true,
  "project_id": <number>,
  "dsn_validated": true,
  "message": "Project 'georgia-singer' created successfully with tenant DB"
}
```

If the saga **fails at any step**, it:
1. Returns a structured error with step number and recovery action
2. Queues a repair task in `roadmap.project_repair_queue`
3. Leaves `bootstrap_status` in a transient state (not `live`)

**See Rollback & Recovery** section for manual remediation.

---

### **Step 2: Verify Registry State**

After saga completion, confirm:

```bash
# Check registry
psql -h 127.0.0.1 -U admin -d agenthive -c "
  SELECT
    project_id, slug, name, db_name, db_role, schema_prefix,
    bootstrap_status, created_at
  FROM roadmap.project
  WHERE slug = 'georgia-singer';
"
```

**Expected state**:
| Column | Expected Value |
|--------|-----------------|
| slug | georgia-singer |
| db_name | georgia_singer |
| db_role | georgia_singer_owner |
| schema_prefix | song_ |
| bootstrap_status | live |

---

### **Step 3: Verify Database & Role**

```bash
# Check database exists
psql -h 127.0.0.1 -U admin -c "\l+ georgia_singer"

# Expected: listing for georgia_singer, size ~10MB (fresh schema only)

# Check role exists and is DB owner
psql -h 127.0.0.1 -U admin -c "\du georgia_singer_owner"

# Expected: listing with CREATEDB, INHERIT, CANLOGIN attributes
```

**AC-1 Verified** ✓

---

### **Step 4: Verify Bootstrap Schema**

```bash
# Connect via service DSN (config.getProjectDb resolves it)
# Or direct connection for manual verification
psql -h 127.0.0.1 -U georgia_singer_owner -d georgia_singer -c "
  SELECT * FROM song_meta.health();
"
```

**Expected output**: JSON object with schema_name, migration_count, etc.

Example:
```json
{
  "status": "healthy",
  "schema_name": "song_meta",
  "migration_count": 1,
  "last_migration": "001-initial-schema",
  "timestamp": "2026-06-09T14:23:45Z"
}
```

**AC-2 Verified** ✓

---

### **Step 5: Verify Vault Entries**

```bash
# Check vault entries exist (mode 0600)
ls -la /vault/file/project/georgia-singer/

# Expected files:
# -rw------- ... db_password
# -rw------- ... dsn

# Validate DSN format
cat /vault/file/project/georgia-singer/dsn

# Expected:
# postgres://georgia_singer_owner:@127.0.0.1:6432/georgia_singer
```

**AC-3 Verified** ✓

---

### **Step 6: Verify Config.getProjectDb() Resolution**

Node.js smoke test:

```typescript
// File: /tmp/test-georgia-getProjectDb.ts
import { config } from './src/config/index.ts';

const pool = await config.getProjectDb('georgia-singer');
const result = await pool.query('SELECT * FROM song_meta.health()');
console.log('Pool works:', result.rows[0]);
pool.end();
```

Run via:
```bash
cd /data/code/AgentHive
npx tsx /tmp/test-georgia-getProjectDb.ts
```

**Expected output**: JSON health object, no errors.

**AC-5 Verified** ✓

---

### **Step 7: Verify Cross-Tenant Isolation**

Attempt to access control-plane tables via georgia_singer_owner role:

```bash
# This should FAIL with permission denied
psql -h 127.0.0.1 -U georgia_singer_owner -d agenthive -c "
  SELECT * FROM roadmap.project LIMIT 1;
"

# Expected error:
# ERROR:  permission denied for schema roadmap
```

Also verify DEFAULT PRIVILEGES were applied:

```bash
# Connect as admin to georgia_singer DB
psql -h 127.0.0.1 -U admin -d georgia_singer -c "
  SELECT * FROM information_schema.role_privileges
  WHERE grantee = 'georgia_singer_owner'
  AND privilege_type != 'USAGE';
"

# Expected: empty result set (no privileges beyond schema USAGE)
```

**AC-6 Verified** ✓

---

### **Step 8: Smoke Test — Song_Meta Health**

```bash
psql -h 127.0.0.1 -U georgia_singer_owner -d georgia_singer -c "
  SELECT * FROM song_meta.health();
"
```

Output confirms:
- Pool connectivity ✓
- song_meta schema exists ✓
- health() function callable ✓

**AC-7 Verified** ✓

---

### **Step 9: Immediate pg_dump Smoke Test**

```bash
# Create backup directory (if not already present)
sudo mkdir -p /var/backups/agenthive/georgia-singer
sudo chmod 750 /var/backups/agenthive/georgia-singer
sudo chown postgres:postgres /var/backups/agenthive/georgia-singer

# Run immediate dump
pg_dump -h 127.0.0.1 -U admin georgia_singer \
  > /var/backups/agenthive/georgia-singer/immediate.sql

# Verify file exists and is readable
ls -lah /var/backups/agenthive/georgia-singer/immediate.sql

# Expected:
# -rw-r--r-- ... 15K immediate.sql (rough size for fresh schema)
```

**AC-8 Verified** ✓

---

### **Step 10: Arm Backup Cron**

Add entry to `/etc/cron.d/agenthive-backup`:

```bash
# Template line (copy, fill placeholders, add to cron.d)
15 3 * * * postgres /usr/local/bin/agenthive-tenant-backup.sh georgia-singer >> /var/log/agenthive/georgia-singer-backup.log 2>&1
```

**Breakdown**:
- **15 3**: 03:15 UTC daily
- **postgres**: Run as postgres user
- **agenthive-tenant-backup.sh**: Generic backup script (parameterized by tenant slug)
- **georgia-singer**: Tenant slug argument
- **Log redirect**: Separate log file per tenant

Verify entry:

```bash
grep georgia-singer /etc/cron.d/agenthive-backup
```

Expected: One line matching the pattern above.

**AC-9 Verified** ✓

---

### **Step 11: Prometheus Metrics**

Georgia-singer metrics are exposed automatically on the next Prometheus scrape cycle (~60 seconds).

Verify in Prometheus UI or via curl:

```bash
curl http://localhost:9090/api/v1/query?query=pg_database_size_bytes{db%3D%22georgia_singer%22}
```

Expected: Metric present with 4-digit byte value (fresh schema = ~10MB).

**AC-10 Verified** ✓

---

### **Step 12: Project-Specific DDL (P508 Dependency)**

**Status**: Deferred pending P508 completion.

**Action**:
- If `scripts/tenant-migrate.ts` is live post-P508, operator runs:
  ```bash
  cd /data/code/AgentHive
  npx tsx scripts/tenant-migrate.ts georgia-singer
  ```

- If not yet live, operator applies DDL manually via psql (documented in P508).

**Document Decision**: Add note to `/tmp/georgia-singer-ddl-decision.log`:
```
P514 AC-11 (Project DDL):
- Date: 2026-06-09
- Status: Deferred to P508
- Scripts/tenant-migrate.ts live: [YES/NO]
- Method: [AUTO via scripts, MANUAL via psql]
- Executed by: [operator name, date-time]
```

**AC-11 Verified** ✓

---

### **Step 13: Vault Atomicity & Rollback Semantics (P495 Dependency)**

P495 defines saga rollback semantics. Document in deployment record:

```
P514 AC-12 (Vault Saga Atomicity):
- Dependency: P495 (deployed: YES/NO)
- Vault write atomicity: [Documented in P495, reference issue #XXXX]
- Orphaned role/database cleanup: [Manual playbook available: /docs/runbooks/P495-cleanup.md]
- Executed successfully: YES
```

**AC-12 Verified** ✓

---

### **Step 14: Update PgBouncer Configuration**

Edit `/etc/pgbouncer/pgbouncer.ini` and add georgia_singer database entry:

```ini
; Add to [databases] section:

georgia_singer = host=127.0.0.1 port=5432 dbname=georgia_singer user=georgia_singer_owner
```

Reload PgBouncer:

```bash
sudo systemctl reload pgbouncer

# Or via signal:
kill -HUP $(pgrep -f /etc/pgbouncer/pgbouncer.ini)
```

Verify connection pool:

```bash
psql -h 127.0.0.1 -p 6432 -U georgia_singer_owner -d georgia_singer -c "SELECT 1;"
```

Expected: `1` returned (connection established through PgBouncer).

**AC-13 Verified** ✓

---

## Rollback & Recovery

### **Scenario: Saga Fails at Step N**

The saga returns:
```json
{
  "ok": false,
  "step": 5,
  "code": "db_creation_failed",
  "message": "CREATE DATABASE failed: disk space exceeded",
  "recovery_action": "operator_fix"
}
```

Repair queue entry created:
```bash
SELECT * FROM roadmap.project_repair_queue WHERE project_id = <id>;
```

### **Manual Cleanup Steps**

1. **Check registry status**:
   ```bash
   SELECT slug, bootstrap_status FROM roadmap.project WHERE slug='georgia-singer';
   ```

2. **Identify failed step** from repair queue:
   ```bash
   SELECT phase, failure_reason FROM roadmap.project_repair_queue WHERE project_id=<id>;
   ```

3. **Cleanup based on phase**:

   - **Phase: registry_insert_failed**
     ```bash
     -- Clean up registry row (safe, no cascading consequences)
     DELETE FROM roadmap.project WHERE slug='georgia-singer';
     ```

   - **Phase: role_creation_failed**
     ```bash
     -- Drop orphaned role (if it exists)
     DROP ROLE IF EXISTS georgia_singer_owner;
     ```

   - **Phase: db_creation_failed**
     ```bash
     -- Drop orphaned database (if it exists)
     DROP DATABASE IF EXISTS georgia_singer;
     DROP ROLE IF EXISTS georgia_singer_owner;
     ```

   - **Phase: schema_bootstrap_failed**
     ```bash
     -- Database exists but schema incomplete
     -- Option A: Drop and retry saga
     DROP DATABASE georgia_singer;
     DROP ROLE georgia_singer_owner;
     DELETE FROM roadmap.project WHERE slug='georgia-singer';
     
     -- Option B: Repair schema (requires manual analysis)
     -- Contact architect for schema migration plan
     ```

4. **Retry saga**:
   ```bash
   # After cleanup, re-invoke project_create_v2
   mcp_proposal action="call_tool" tool_name="project_create_v2" args='{
     "slug": "georgia-singer",
     "name": "Georgia Singer"
   }'
   ```

### **Scenario: Partial Success (Status Stuck in Transient)**

If bootstrap_status shows `db_role_created` or `db_created` but saga did not advance:

1. Check repair queue for stale entries:
   ```bash
   SELECT * FROM roadmap.project_repair_queue
   WHERE project_id = (SELECT project_id FROM roadmap.project WHERE slug='georgia-singer')
   AND status IN ('queued', 'in_progress');
   ```

2. If stale (older than 1 hour), mark completed:
   ```bash
   UPDATE roadmap.project_repair_queue
   SET status='completed'
   WHERE project_id=(SELECT project_id FROM roadmap.project WHERE slug='georgia-singer')
   AND status='in_progress';
   ```

3. Manually advance bootstrap_status to next phase or skip to 'live':
   ```bash
   -- Only if manual verification confirms schemas are healthy
   UPDATE roadmap.project
   SET bootstrap_status='live'
   WHERE slug='georgia-singer' AND bootstrap_status != 'live';
   ```

---

## Dry-Verification (Non-Destructive Pre-Flight)

Before executing the live saga, validate that all templates and config values are correct:

```bash
# 1. Check template SQL files parse
cd /data/code/AgentHive

# 2. Verify config slug resolves
npx tsx -e "
  import { config } from './src/config/index.ts';
  try {
    const cfg = config.getProjectDb('georgia-singer');
    console.log('Config resolves OK');
  } catch (e) {
    console.error('Config resolution FAILED:', e.message);
  }
"

# 3. Validate schema_prefix doesn't collide
psql -h 127.0.0.1 -U admin -d agenthive -c "
  SELECT schema_name FROM information_schema.schemata
  WHERE schema_name LIKE 'song_%' AND schema_name != 'song_meta';
"
# Expected: empty result set (no collisions)

# 4. Verify Postgres role doesn't pre-exist
psql -h 127.0.0.1 -U admin -c "SELECT 1 WHERE EXISTS(SELECT 1 FROM pg_roles WHERE rolname='georgia_singer_owner');"
# Expected: empty result set
```

---

## Success Criteria Checklist

- [ ] AC-1: Database exists, owned by georgia_singer_owner
- [ ] AC-2: Bootstrap schema installed (song_meta.health() callable)
- [ ] AC-3: Vault DSN entries exist with mode 0600
- [ ] AC-4: Registry row has bootstrap_status='live'
- [ ] AC-5: getProjectDb('georgia-singer') returns working pool
- [ ] AC-6: Cross-tenant isolation enforced (SELECT denied)
- [ ] AC-7: song_meta.health() returns valid response
- [ ] AC-8: pg_dump immediate test succeeds
- [ ] AC-9: Backup cron entry present in /etc/cron.d/agenthive-backup
- [ ] AC-10: Prometheus metrics visible on next scrape
- [ ] AC-11: Project-specific DDL executed or deferred with decision documented
- [ ] AC-12: Vault saga semantics confirmed (P495 dependency)
- [ ] AC-13: PgBouncer config updated and reload verified

---

## Operator Sign-Off

```
Operator: __________________________
Date: __________________________
All 13 ACs Verified: [YES / PARTIAL / NO]
Rollback Required: [YES / NO]
Notes:
_________________________________________________________________
_________________________________________________________________
```

---

## Appendix: Parameterization Reference

| Parameter | Value | Notes |
|-----------|-------|-------|
| Project Slug | georgia-singer | Lowercase, no spaces |
| DB Name | georgia_singer | Derived from slug (- → _) |
| DB Role | georgia_singer_owner | Derived from db_name + _owner |
| Schema Prefix | song_ | Project-specific (specified in P514) |
| Vault Path | vault://file/project/georgia-singer/ | Standard pattern |
| Backup Cron Time | 03:15 UTC | Staggered: agenthive=01:15, monkeyking-audio=02:15, georgia-singer=03:15 |
| PgBouncer Port | 6432 | Standard pgbouncer listening port |
| Data Directory | /var/lib/postgresql/ | Default Postgres data directory |
| Backup Directory | /var/backups/agenthive/georgia-singer/ | Standard ops directory |

---

## Related Documents

- **P429**: Two-tier topology specification (parent proposal)
- **P495**: Tenant saga pattern + rollback semantics
- **P508**: Tenant bootstrap DDL templates (Stage D3)
- **P513**: MonkeyKing-audio bringup (sibling, reference implementation)
- **CONVENTIONS.md §6.0**: Multi-project DB topology diagram

---

**Last Updated**: 2026-06-09  
**Runbook Version**: 1.0  
**Status**: READY FOR OPERATOR EXECUTION
