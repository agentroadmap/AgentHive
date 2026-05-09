> **Type:** runbook  
> **MCP-tracked:** P504 (rehearsal), P505 (plan freeze), P507 (tenant grandfather)  
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` rows for the P429 stage chain

# AgentHive Two-Tier DB Cutover Playbook

This runbook covers the full production cutover from AgentHive's original single-database
setup to the two-tier topology (hiveControl + per-project tenant DBs) defined in P429.
It serves as the rehearsal template (P504) and the frozen production plan base (P505).

**P507 follow-up (Stage D2):** After the production cutover completes, the `agenthive`
Postgres database must be registered as project_id=1 tenant via `project_attach`. See
[§7 Stage D2 — Grandfather agenthive tenant DB](#7-stage-d2--grandfather-agenthive-tenant-db).

---

## Proposal Stage Map

| Stage | Proposal | Description |
| --- | --- | --- |
| A | P429 | hiveControl bootstrap + control-pool shim (already shipped) |
| B | P501–P503 | Migration 062, logical replication, 48h zero-delta shadow read |
| C1 | P504 | Rehearsal — dry-run this runbook on staging |
| C2a | P505 | Plan freeze — sign the production runbook |
| C2b | P519 | Execute — run C3 steps on production |
| C3 | P506 | Drop agenthive control schemas; install FDW shim; drop dead project_id columns |
| D2 | **P507** | Register agenthive as live project_id=1 tenant DB |
| D3+ | P513, P514 | Bring up monkeyKing-audio and georgia-singer as additional tenants |

---

## Pre-Flight Checklist

Run before any production window opens. Every item requires a verification command with
expected output. Do NOT proceed if any item is unresolved.

| # | Check | Command | Expected |
| --- | --- | --- | --- |
| 1 | Replication lag = 0 | `psql -d hiveControl -c "SELECT lag_bytes FROM pg_stat_replication WHERE slot_name='agenthive_cutover_slot';"` | `lag_bytes = 0` |
| 2 | MCP health endpoint OK | `curl -s -m 5 http://127.0.0.1:6421/health \| jq '.status'` | `"ok"` |
| 3 | Zero active app connections to hiveControl pre-flip | `psql -d hiveControl -c "SELECT count(*) FROM pg_stat_activity WHERE application_name ~ 'agenthive-api\|mcp-server' AND state != 'idle';"` | `0` |
| 4 | Backup destination writable | `pg_dumpall --schema-only -h 127.0.0.1 -p 5432 > /var/backups/agenthive/pre-cutover-$(date +%Y%m%d).sql && echo OK` | `OK` |
| 5 | Rollback DSN reachable | `psql "postgres://rollback_user:${ROLLBACK_PASS}@${ROLLBACK_HOST}/agenthive" -c "SELECT 1;"` | `1` |
| 6 | Sequence-bump script dry-run passes | `psql -d agenthive -f scripts/deploy/sequence-bump.sql --variable=DRY_RUN=1` | no errors, count matches baseline |
| 7 | P503 zero-delta evidence captured | `docs/runbooks/cutover-playbook.md §P503-evidence` section filled with signed artifact | artifact present |
| 8 | P507 vault entry readable | `vault read vault://file/project/agenthive/dsn` | returns DSN string |

---

## Incident Command Roles

| Role | Authority | Action on abort |
| --- | --- | --- |
| **Operator** | Primary executor; sequence and timing | Flip env DSN back within 2 min |
| **DB-Deploy Witness** | Observes replication lag, validates post-cutover queries | Calls ABORT if any trigger fires |
| **Comms Lead** | Posts to #incidents Slack thread + status page | No technical decisions |
| **Escalation Contact** | VP Eng or on-call manager | Final ABORT authority |

---

## Abort Triggers (run every 3 min during window)

Abort immediately if any of the following shell commands returns an unexpected result:

```bash
# Replication lag must reach 0 by T+10s and stay there
psql -d hiveControl -c \
  "SELECT lag_bytes FROM pg_stat_replication WHERE slot_name='agenthive_cutover_slot';"
# ABORT if: lag_bytes > 0 at T+10s, query hangs > 10s, or returns no rows

# Write to hiveControl must succeed
psql -d hiveControl -c "SELECT COUNT(*) FROM roadmap.proposal LIMIT 1;"
# ABORT if: ERROR, or response > 5s

# MCP health
curl -s -m 5 http://127.0.0.1:6421/health | jq '.replication_slot_lag_bytes'
# ABORT if: response != 200, or lag_bytes > 1000000, or timeout
```

On any abort trigger: Escalation Contact calls ABORT. Operator flips env DSN back to
`agenthive` within 2 minutes. Comms Lead posts "cutover paused; investigating."

---

## §1 Stage B — Replication Start (P501–P503)

Already completed before this runbook is executed in production. Evidence captured in
`docs/runbooks/stage-b-replication-evidence.md` (produced during P503).

Key validation (confirm before C3):

```sql
-- On agenthive: verify replication slot is active
SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag
  FROM pg_replication_slots
 WHERE slot_name = 'agenthive_cutover_slot';
-- Expected: active = true, lag < 1 kB
```

---

## §2 Stage C1 — Rehearsal (P504)

Run this full playbook on a staging clone of agenthive before committing any production
changes. Record actual output for each expected-output block. The rehearsal artifact
becomes the basis for the P505 plan freeze.

```bash
# Clone production agenthive to staging
pg_dump -h 127.0.0.1 -p 5432 agenthive | psql -h staging-host staging_agenthive
```

Then follow §3–§6 of this runbook against staging. Record timings at each numbered step.

---

## §3 Stage C2b — Production Cutover Execution (P519)

> **Gate:** P505 (plan freeze) must be in state COMPLETE before executing this section.

### T+0 — Open maintenance window

Post to #incidents:
```
[T+0] Cutover window OPEN. Operator: @<name>. Comms: @<name>. DB-Witness: @<name>.
Expected completion: T+60min. Updates every 5 min.
Runbook: cutover-prod-<date>-FROZEN (git tag)
Rollback DSN available in vault.
```

### T+1 — Sequence bump

```bash
psql -d agenthive -f scripts/deploy/sequence-bump.sql
```

Expected: every sequence in `roadmap` and `roadmap_proposal` bumped to `max(id)+1000`.
Output lists each sequence name, old value, and new value. Elapsed < 10s.

### T+5 — Pre-flip traffic routing validation

```bash
psql -d hiveControl -c \
  "SELECT count(*) FROM pg_stat_activity
   WHERE application_name ~ 'agenthive-api|mcp-server' AND state != 'idle';"
# MUST return 0. If > 0, ABORT.
```

### T+10 — Flip env DSN

```bash
# On operator host
sudo sed -i 's|^CONTROL_DB_NAME=.*|CONTROL_DB_NAME=hiveControl|' /etc/agenthive/env
sudo systemctl restart agenthive-mcp
```

Verify flip applied:
```bash
grep CONTROL_DB_NAME /etc/agenthive/env
# MUST show hiveControl. If still agenthive, ABORT.
```

### T+15 — Post-flip connection validation

```bash
psql -d hiveControl -c \
  "SELECT count(*) FROM pg_stat_activity
   WHERE application_name ~ 'agenthive-api|mcp-server';"
# MUST be > 0 within 30s (application reconnected to hiveControl).
```

### T+20 — MCP health check

```bash
curl -s http://127.0.0.1:6421/health | jq '{status, db_name, replication_slot_lag_bytes}'
# Expected: status=ok, db_name=hiveControl, replication_slot_lag_bytes=0
```

### T+30 — Post-cutover validation queries

```sql
-- On hiveControl: proposals P502–P505 present and correct
SELECT COUNT(*) FROM roadmap.proposal WHERE id IN (502, 503, 504, 505);
-- Expected: 4

-- On hiveControl: write round-trip < 500ms
UPDATE roadmap.proposal SET modified_at = NOW() WHERE id = 505 RETURNING id, modified_at;
-- Expected: 1 row; modified_at within 1s of now

-- Confirm db_name reported by MCP
SELECT current_database(), inet_server_addr(), inet_server_port();
-- Expected: hiveControl | 127.0.0.1 | 5432
```

### T+60 — Close window

Post to #incidents: `[T+60] CUTOVER COMPLETE. All validation queries passed.`
Update status page: `Resolved — no data loss or service interruption.`

---

## §4 Stage C3 — Drop agenthive Control Schemas (P506)

> **Gate:** T+7 days post-cutover with zero hiveControl issues.

See P506 design for the full three-phase playbook:

1. **Phase 1 (T+7 days):** Forensic pg_dump snapshot → drop `roadmap` and
   `roadmap_proposal` schemas from agenthive → install FDW shim → drop dead
   `project_id` columns from hiveControl non-policy tables.

2. **Phase 2 (T+21 days):** If FDW hit count = 0 for 14 days, drop FDW entirely.

Pre-drop forensic snapshot:
```bash
pg_dump --schema-only --no-owner --no-acl agenthive \
  > /var/backups/agenthive/pre-p506-drop-$(date +%Y%m%d-%H%M%S).sql
```

Schema sanity before drop (expected: 0 rows indicating no base tables remain in control schemas):
```sql
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_catalog = 'agenthive'
   AND table_type = 'BASE TABLE'
   AND table_schema IN ('roadmap', 'roadmap_proposal');
```

---

## §5 Rollback Procedure

### Rollback pre-flip (T < T+10)

No action needed. `CONTROL_DB_NAME` is unset; `getControlPool()` automatically returns
the existing agenthive pool.

### Rollback post-flip (T+10 to T+7d shadow hold)

```bash
sudo sed -i 's|^CONTROL_DB_NAME=.*|CONTROL_DB_NAME=agenthive|' /etc/agenthive/env
sudo systemctl restart agenthive-mcp
# Control-plane restored in < 30s.
```

Verify:
```bash
curl -s http://127.0.0.1:6421/health | jq '.db_name'
# Expected: "agenthive"
```

### Rollback post-P506 schema drop

Restore from pre-drop backup:
```bash
psql -d agenthive < /var/backups/agenthive/pre-p506-drop-<date>.sql
```

RTO < 30 min. See `docs/operations/hivecontrol-fallback.md §3`.

---

## §6 Post-Cutover Housekeeping

After a stable 7-day window:

- Remove agenthive replication slot: `SELECT pg_drop_replication_slot('agenthive_cutover_slot');`
- Keep pre-cutover agenthive backup for 90 days before deletion.
- Update system crontab: remove any replication-health alerts targeting the old agenthive slot.
- File P513 / P514 once agenthive tenant registration (P507) is confirmed live.

---

## §7 Stage D2 — Grandfather agenthive Tenant DB (P507)

**When:** After P505 cutover completes (hiveControl is live) and P506 control schema drop
is done (no roadmap/roadmap_proposal base tables remain in agenthive).

**What:** Register the `agenthive` Postgres database as the first live tenant in
`hiveControl.roadmap.project` (project_id=1, already seeded in migration 050) using
the `project_attach` MCP action.

### Pre-requisites

1. Vault entry `vault://file/project/agenthive/dsn` exists and is readable by the service user.
2. `agenthive_app` Postgres role exists with grants on tenant schemas (all non-roadmap* schemas).
3. P506 complete: zero BASE TABLEs in `roadmap` or `roadmap_proposal` schemas in agenthive.

Verify prerequisites:
```bash
# 1. Vault entry
vault read vault://file/project/agenthive/dsn
# Expected: returns postgres://agenthive_app:...@127.0.0.1:6432/agenthive?...

# 2. Role grants (>0 rows required)
psql -d agenthive -c \
  "SELECT COUNT(*) FROM information_schema.role_table_grants
   WHERE grantee='agenthive_app'
   AND table_schema NOT IN ('roadmap', 'roadmap_proposal', 'pg_catalog', 'information_schema');"
# Expected: > 0

# 3. No control schemas remain
psql -d agenthive -c \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_catalog='agenthive' AND table_type='BASE TABLE'
   AND table_schema IN ('roadmap', 'roadmap_proposal');"
# Expected: 0
```

### Attach Command

```
mcp_proposal action=project_attach \
  slug=agenthive \
  name='AgentHive (self)' \
  dsn_secret_ref=vault://file/project/agenthive/dsn \
  db_name=agenthive \
  db_role=agenthive_app \
  schema_prefix=agenthive_ \
  host=127.0.0.1 \
  port=6432 \
  bootstrap_status=live
```

Expected return: `{ok: true, project_id: 1, dsn_validated: true, schema_check: 'no_control_schemas_present'}`

Idempotency: if called again with slug=agenthive and row already shows `bootstrap_status='live'`,
returns `{ok: true, already_attached: true, project_id: 1}` — no re-validation.

### Post-Attach Validation

```sql
-- On hiveControl: confirm registration
SELECT slug, db_name, bootstrap_status, dsn_secret_ref IS NOT NULL AS has_secret
  FROM roadmap.project
 WHERE slug = 'agenthive';
-- Expected: agenthive | agenthive | live | true
```

```typescript
// Runtime check (run from MCP context or test harness)
const pool = await config.getProjectDb('agenthive');
await pool.query('SELECT 1');
// Expected: no error

const poolById = await config.getProjectDb(1);
await poolById.query('SELECT 1');
// Expected: no error (numeric id resolves same pool)
```

### Partial-State Recovery

If `project_attach` breaks mid-flight (vault reachable, DSN connection times out):

- The hiveControl.roadmap.project row is NOT committed (rollback).
- Operator can safely retry the attach command.
- If row exists with `bootstrap_status=NULL` or `bootstrap_status='error'` (partial insert):
  ```sql
  -- On hiveControl
  UPDATE roadmap.project SET bootstrap_status = 'error', updated_at = NOW()
   WHERE slug = 'agenthive' AND bootstrap_status IS DISTINCT FROM 'live';
  ```
  Then re-invoke `project_attach` — the UPSERT path handles the correction.

---

## §8 Evidence Log

After each stage completes, append an entry to this section with:

- Stage identifier (e.g., C2b, D2)
- Completion timestamp
- Operator name
- Observed output for each validation query
- Any deviations from expected output and their resolution

```
## Evidence: Stage C2b (Production Cutover)
Date: <YYYY-MM-DD HH:MM UTC>
Operator: <name>
Witness: <name>
Replication lag at flip: 0 bytes
Post-flip reconnect time: <N> seconds
Validation query results: (paste SELECT output)
Notes: <none|deviation description>

## Evidence: Stage D2 (P507 agenthive Tenant Grandfather)
Date: <YYYY-MM-DD HH:MM UTC>
Operator: <name>
project_attach result: {ok: true, project_id: 1, dsn_validated: true, ...}
getProjectDb('agenthive') SELECT 1: OK
getProjectDb(1) SELECT 1: OK
hiveControl.roadmap.project row: agenthive | agenthive | live | true
Notes: <none|deviation description>
```

---

*This runbook is the output of P504 (rehearsal) and is frozen as the base for P505 (plan freeze).
Amendments require a new proposal referencing the specific section changed.*
