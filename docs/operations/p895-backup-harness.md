# Backup Harness Runbook — P895

**Proposal:** P895 — G5 (audit): backup harness + verify cron for agentHive2  
**Status:** COMPLETE  
**Last revised:** 2026-05-11

---

## 0. Overview

P895 ships a full logical-backup harness for `agentHive2`. It covers:

| Component | What it does |
|---|---|
| `core.tenant_backup` | Append-only audit manifest — one row per backup taken or verified |
| `core.tenant_backup_policy` | Per-project policy (schedule, retention, target prefix) |
| `deploy/scripts/backup.sh` | pg_dump wrapper — full-DB or per-schema; inserts manifest row |
| `deploy/scripts/verify-backup.sh` | Restores a backup to an ephemeral DB, runs smoke, updates manifest |
| `deploy/scripts/prune-backup.sh` | Deletes files past `retention_until`; soft-tombstones manifest rows |
| `scripts/cron/agenthive2-backup-daily.sh` | Docker-aware daily cron (04:00 UTC) |
| `scripts/cron/agenthive2-backup-verify.sh` | Docker-aware weekly verify cron |
| `scripts/cron/agenthive2-backup-prune.sh` | Docker-aware daily prune cron (05:00 UTC) |
| MCP tools `backup_take` / `backup_verify` / `backup_list` | Operator CLI surface |

**PITR / WAL archiving is out of scope for v1.** Full DR drill procedures live in `docs/dr/`.

---

## 1. Schema

### 1.1 `core.tenant_backup`

Append-only — a PostgreSQL RULE blocks DELETE. Only `verified_at`, `verify_status`, and `metadata_jsonb` (soft-pruned tombstone) are updated after insert.

```sql
backup_id        UUID         PK  DEFAULT gen_random_uuid()
project_id       BIGINT       FK core.project(id)  NULL = full-DB backup
taken_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
backup_kind      TEXT         CHECK IN ('full','schema','wal')
storage_uri      TEXT         NOT NULL   -- file:// or s3://
size_bytes       BIGINT
schema_name      TEXT                    -- set for backup_kind='schema'
pg_version       TEXT
dump_format      TEXT         DEFAULT 'custom'
verified_at      TIMESTAMPTZ             -- set by verify step
verify_status    TEXT         CHECK IN ('ok','failed',NULL)
retention_until  TIMESTAMPTZ  NOT NULL
metadata_jsonb   JSONB        DEFAULT '{}'
created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
```

Useful SRE queries:

```sql
-- Last backup per project
SELECT p.slug, max(tb.taken_at) AS last_backup
FROM core.tenant_backup tb
JOIN core.project p ON tb.project_id = p.id
GROUP BY 1 ORDER BY 2 DESC;

-- Unverified backups older than 8 days (should be empty in a healthy system)
SELECT backup_id, schema_name, taken_at
FROM core.tenant_backup
WHERE verified_at IS NULL
  AND taken_at < now() - interval '8 days';

-- Recent verify failures
SELECT backup_id, schema_name, taken_at, verified_at
FROM core.tenant_backup
WHERE verify_status = 'failed'
ORDER BY taken_at DESC LIMIT 20;

-- Space used by active (non-pruned) backups per project
SELECT schema_name, count(*), pg_size_pretty(sum(size_bytes))
FROM core.tenant_backup
WHERE metadata_jsonb->>'pruned_at' IS NULL
GROUP BY 1 ORDER BY 2 DESC;
```

### 1.2 `core.tenant_backup_policy`

One row per project. `backup.sh` reads this at runtime.

```sql
project_id         BIGINT PK  FK core.project(id)
schedule_cron      TEXT   DEFAULT '0 3 * * *'
retention_days     INT    DEFAULT 30
target_uri_prefix  TEXT   DEFAULT 'file:///var/backups/agenthive'
backup_kind        TEXT   DEFAULT 'full'  CHECK IN ('full','schema','wal')
enabled            BOOLEAN DEFAULT TRUE
```

Default seed row for the `agentHive` project is applied by:
- `deploy/system-init/009-backup.sql` (in `apply.sh` step 009)
- `deploy/project-init/seed/backup-policy.sql` (called with `-v schema_name=<slug>` per project)

---

## 2. Scripts

### 2.1 `deploy/scripts/backup.sh`

Takes a pg_dump backup and records the result in `core.tenant_backup`.

```bash
# Full DB backup (project_id = NULL in manifest)
./deploy/scripts/backup.sh -h 127.0.0.1 -p 5432 -U admin -d agentHive2

# Per-schema backup for project slug "monkeyKing"
./deploy/scripts/backup.sh -s monkeyKing -o /var/backups/agenthive

# Dry-run to verify commands without executing
./deploy/scripts/backup.sh --dry-run
```

Options: `-h HOST`, `-p PORT`, `-U USER`, `-d DATABASE`, `-s SCHEMA`, `-o OUTPUT_DIR`, `--dry-run`

Retention is read from `core.tenant_backup_policy` for the given schema. Falls back to 30 days.

### 2.2 `deploy/scripts/verify-backup.sh`

Restores a specific backup to an ephemeral `agentHive2_verify_<ts>` DB, runs a table-count smoke test, then drops the temp DB and updates `verify_status` in the manifest.

```bash
# Verify a specific backup UUID
./deploy/scripts/verify-backup.sh -b <backup_uuid>

# Dry-run
./deploy/scripts/verify-backup.sh -b <backup_uuid> --dry-run
```

On failure: inserts a row into `governance.event` with `event_type = 'backup_verify_failed'` and exits 1.

Requires `CREATEDB` privilege on the connecting user (already held by `admin`).

### 2.3 `deploy/scripts/prune-backup.sh`

Deletes backup files past `retention_until` and attempts to DELETE manifest rows. Because the `tenant_backup_no_delete` RULE blocks DELETE for most roles, the script:
1. Sets `metadata_jsonb.pruned_at` (soft-tombstone) — always succeeds.
2. Attempts `DELETE` — succeeds if the role has superuser or the rule is bypassed; silently skips otherwise.

```bash
# Live prune
./deploy/scripts/prune-backup.sh

# Dry-run: shows what would be deleted
./deploy/scripts/prune-backup.sh --dry-run
```

---

## 3. Cron Schedule

The cron scripts in `scripts/cron/` are Docker-aware wrappers around the deploy scripts above. Wire them into `/etc/cron.d/agenthive-reporting` on the production host.

| Script | Suggested cron | Purpose |
|---|---|---|
| `agenthive2-backup-daily.sh` | `0 4 * * *` | Full + per-schema dumps |
| `agenthive2-backup-verify.sh` | `0 10 * * 0` | Weekly verify (Sunday 10:00 UTC) |
| `agenthive2-backup-prune.sh` | `0 5 * * *` | Daily prune (after backup) |

Example cron block (append to `/etc/cron.d/agenthive-reporting`):

```cron
# P895 — agentHive2 backup harness
0 4 * * *   xiaomi bash /data/code/AgentHive/scripts/cron/agenthive2-backup-daily.sh  >> /var/log/agenthive/backup-daily-cron.log  2>&1
0 5 * * *   xiaomi bash /data/code/AgentHive/scripts/cron/agenthive2-backup-prune.sh  >> /var/log/agenthive/backup-prune-cron.log  2>&1
0 10 * * 0  xiaomi bash /data/code/AgentHive/scripts/cron/agenthive2-backup-verify.sh >> /var/log/agenthive/backup-verify-cron.log 2>&1
```

Logs are written to `/var/log/agenthive/backup-{daily,prune,verify}-<timestamp>.log`.

---

## 4. MCP Interface

Three tools are registered under the `mcp_backup` domain in the MCP server (`src/apps/mcp-server/tools/backup/`). They are available from the hive CLI.

### `backup_take`

```json
{
  "schema": "monkeyKing",     // omit for full-DB backup
  "host": "127.0.0.1",
  "port": 5432,
  "user": "admin",
  "database": "agentHive2",
  "output_dir": "/var/backups/agenthive",
  "dry_run": false
}
```

### `backup_verify`

```json
{
  "backup_id": "<UUID from core.tenant_backup>",
  "dry_run": false
}
```

### `backup_list`

```json
{
  "schema": "monkeyKing",     // optional filter
  "limit": 50,
  "include_pruned": false
}
```

Returns tabular output: `backup_id  kind  taken_at  schema/project  verify=ok|failed|none  size=NKB  retain_until=...`

---

## 5. Operational Procedures

### 5.1 Take an ad-hoc backup

```bash
# Full DB (from project root)
./deploy/scripts/backup.sh -U admin

# Specific project schema
./deploy/scripts/backup.sh -s monkeyKing -U admin
```

Or via MCP: invoke `backup_take` with the appropriate schema.

### 5.2 Manually verify a backup

1. Find the `backup_id` to verify:
   ```sql
   SELECT backup_id, schema_name, taken_at, verified_at
   FROM core.tenant_backup
   WHERE verified_at IS NULL
   ORDER BY taken_at DESC LIMIT 5;
   ```
2. Run the verify script:
   ```bash
   ./deploy/scripts/verify-backup.sh -b <backup_id>
   ```
3. Confirm `verify_status = 'ok'`:
   ```sql
   SELECT verify_status, verified_at FROM core.tenant_backup WHERE backup_id = '<backup_id>';
   ```

### 5.3 Recover from a backup (restore to production)

> This procedure is for data recovery, not a regular drill. For DR drills see `docs/dr/drill-runbook.md`.

```bash
# Restore full-DB backup to a clean DB
pg_restore -h 127.0.0.1 -U admin -d agentHive2_restore \
  -Fc --no-owner --no-privileges /var/backups/agenthive/<dump_file>

# Restore schema-only backup
pg_restore -h 127.0.0.1 -U admin -d agentHive2 \
  -n monkeyKing -Fc --no-owner --no-privileges /var/backups/agenthive/<schema_dump>
```

After restore, validate with:
```sql
SELECT schemaname, tablename, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname NOT IN ('pg_catalog','information_schema')
ORDER BY n_live_tup DESC;
```

### 5.4 Check backup health at a glance

```sql
-- Summary: last backup + last verify per project
SELECT
  p.slug,
  max(CASE WHEN tb.backup_kind = 'full' THEN tb.taken_at END)   AS last_full_backup,
  max(CASE WHEN tb.backup_kind = 'schema' THEN tb.taken_at END) AS last_schema_backup,
  max(tb.verified_at) AS last_verified,
  count(CASE WHEN tb.verify_status = 'failed' THEN 1 END)       AS verify_failures
FROM core.project p
LEFT JOIN core.tenant_backup tb ON tb.project_id = p.id
GROUP BY 1 ORDER BY 2 DESC NULLS LAST;
```

---

## 6. Troubleshooting

### Backup script fails with "postgres-db container not running"

The cron scripts in `scripts/cron/` check for the `postgres-db` Docker container. If the container name differs in your environment, edit the `docker ps --filter "name=postgres-db"` line at the top of each cron script, or use the lower-level `deploy/scripts/backup.sh` directly with explicit `-h`/`-p`/`-U` flags.

### `verify-backup.sh` fails with `createdb_failed`

The connecting user (`admin`) must hold `CREATEDB`. Verify:
```sql
SELECT rolname, rolcreatedb FROM pg_roles WHERE rolname = 'admin';
```
If false: `ALTER ROLE admin CREATEDB;` (requires superuser).

### `verify_status = 'failed'` rows in manifest

Check `governance.event` for the failure detail:
```sql
SELECT payload_jsonb, created_at
FROM governance.event
WHERE event_type = 'backup_verify_failed'
ORDER BY created_at DESC LIMIT 10;
```

Common causes:
- Dump file was deleted before verify ran (check `storage_uri` path)
- `pg_restore` version mismatch — ensure same major Postgres version
- Schema dump was taken with `--single-transaction` and a concurrent DDL left it inconsistent — retake the backup

### Disk usage growing faster than expected

Review retention policy:
```sql
SELECT project_id, retention_days, target_uri_prefix FROM core.tenant_backup_policy;
```
Lower `retention_days` or run `prune-backup.sh --dry-run` to see what would be deleted.

### Prune script logs "delete attempted" but manifest rows remain

The `tenant_backup_no_delete` RULE silently ignores DELETE for non-superuser roles. The row will have `metadata_jsonb.pruned_at` set (soft tombstone). The file is still deleted. If you need to physically remove manifest rows, run as superuser:
```sql
DELETE FROM core.tenant_backup WHERE metadata_jsonb->>'pruned_at' IS NOT NULL;
```

---

## 7. Deployment Checklist

When deploying P895 to a new environment:

- [ ] Run `deploy/apply.sh` to apply `009-backup.sql` (creates `core.tenant_backup` and `core.tenant_backup_policy`)
- [ ] Verify default seed row exists: `SELECT * FROM core.tenant_backup_policy WHERE project_id = (SELECT id FROM core.project WHERE slug = 'agentHive');`
- [ ] Create backup storage directory: `mkdir -p /var/backups/agenthive /var/log/agenthive`
- [ ] Append cron block (section 3 above) to `/etc/cron.d/agenthive-reporting`
- [ ] Confirm `admin` role has `CREATEDB`: `SELECT rolcreatedb FROM pg_roles WHERE rolname='admin';`
- [ ] Test ad-hoc backup: `./deploy/scripts/backup.sh --dry-run`
- [ ] Test ad-hoc verify (after first real backup): `./deploy/scripts/verify-backup.sh -b <backup_id> --dry-run`
- [ ] Confirm MCP tools respond: invoke `backup_list` from hive CLI

---

## 8. Relationship to Other DR Work

| Proposal | Scope | Overlap |
|---|---|---|
| P509 | Tenant DB ops for old hiveCentral topology | Superseded by P895 for agentHive2 |
| P591 | DR drill runbook (`docs/dr/drill-runbook.md`) | AC13 of P591 = quarterly backup-restore drill; uses `scripts/dr/backup-restore-test.sh` |
| G3 (tenant lifecycle) | If G3 ships, `take_backup`/`verify_backup`/`list_backups` fold into `mcp_tenant_lifecycle` | P895 ships standalone `mcp_backup` domain in the interim |

**WAL / PITR:** out of scope for P895 v1. RPO for logical backup-only is 24 h. If RPO < 1 h is needed, a separate WAL archiving proposal is required.
