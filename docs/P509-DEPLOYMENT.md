# P509 Deployment Guide — Tenant DB Ops Bundle

## Overview

P509 adds operational instrumentation for tenant database backups:
- **Prometheus exporter** for pg_stat metrics and backup staleness
- **Disk budget enforcement** via retention cron
- **Provisioning hooks** for automatic backup policy seeding
- **Archive hooks** for cleanup on tenant retirement
- **Alerting rules** for backup health monitoring

Depends on: **P895** (backup core mechanics: pg_dump cron, retention, verify)

## Components

### 1. Scripts (scripts/ops/)

All scripts are shell-based and idempotent:

- `agenthive-tenant-backup.sh <slug> [prod|smoke]`
  - Executes `pg_dump -F c`, validates with `pg_restore --list`, checksums with SHA256
  - Logs to `/var/log/agenthive/backup-${slug}.log`
  - Escalates failures to `roadmap.escalation_log`

- `agenthive-retention-prune.sh <slug> [--dry-run]`
  - Enforces `backup_disk_cap_gb` (default 50 GB per tenant)
  - Deletes oldest dumps first if over cap
  - Emits Prometheus metrics to `/var/lib/node_exporter/textfile/`
  - Policy configurable via `/etc/agenthive/backup-policy.conf` or env

- `agenthive-restore-test.sh <slug>`
  - Monthly verification: restores latest dump to ephemeral DB
  - Validates `COUNT(*)` on all public-schema tables
  - Escalates failures; ephemeral DB auto-cleaned
  - Run via systemd timer or cron

### 2. Prometheus Exporter (scripts/ops/agenthive-pg-stat-exporter.py)

**Service**: `agenthive-pg-stat-exporter.service` (port 9101)

**Metrics exported**:
- `agenthive_scrape_success_total{slug}` — counter
- `agenthive_scrape_staleness_seconds{slug}` — gauge
- `agenthive_db_table_rows{slug, table}` — gauge
- `agenthive_backup_disk_cap_exceeded_total{slug}` — counter (from textfile collector)

**Tenant discovery** (refreshed every 5 minutes):
1. Primary: `SELECT slug FROM roadmap.project WHERE bootstrap_status='live'`
2. Fallback: `/etc/agenthive/tenants.local` (JSON)

**HA configuration**:
- Restart policy: `Restart=always, RestartSec=5, StartLimitBurst=10/60s`
- Continues scraping from local fallback if DB goes down

### 3. Alerting Rules (/etc/prometheus/rules/agenthive-backups.yml)

Four alert rules:
- `AgentHiveBackupStaleness` — backup not verified in 9–14 days
- `AgentHiveScrapeStaleness` — exporter hasn't scraped in 5–10 minutes
- `AgentHiveBackupDiskUsageHigh` — /var disk < 15% free
- `AgentHiveBackupCapExceeded` — per-tenant cap exceeded after cleanup

### 4. Database Schema (migration 220)

**New/Updated**:
- `roadmap.tenant_backup` (created by P895, migration 120)
- `roadmap.tenant_backup_policy.disk_cap_gb` (migration 220)
  - Default: 50 GB per tenant
  - Enforced daily by retention cron

### 5. Provisioning Integration (MCP tools)

**MCP tools**:
- `tenant_ops_setup { project_slug }` — seed backup policy, update tenants.local
- `tenant_ops_cleanup { project_slug }` — remove from tenants.local on archive

## Deployment Steps

### Prerequisites

```bash
# Install Python dependencies on the exporter host
sudo pip install psycopg2-binary prometheus-client

# Ensure /etc/agenthive directory exists
sudo mkdir -p /etc/agenthive
sudo chown root:root /etc/agenthive
sudo chmod 755 /etc/agenthive

# Ensure backup directories exist
sudo mkdir -p /var/backups/agenthive
sudo mkdir -p /var/log/agenthive
sudo mkdir -p /var/lib/node_exporter/textfile
sudo chown -R agenthive:agenthive /var/backups/agenthive /var/log/agenthive
sudo chmod 755 /var/backups/agenthive /var/log/agenthive
```

### Step 1: Deploy Database Migration

```bash
cd /data/code/AgentHive
npm run db:migrate

# Verify migration applied
psql -d agenthive -c "SELECT column_name FROM information_schema.columns WHERE table_schema='roadmap' AND table_name='tenant_backup_policy';"
```

Should output:
```
disk_cap_gb
```

### Step 2: Copy Scripts to /opt/agenthive

```bash
sudo cp -v scripts/ops/agenthive-*.sh /opt/agenthive/scripts/ops/
sudo cp -v scripts/ops/agenthive-*.py /opt/agenthive/scripts/ops/
sudo chown root:root /opt/agenthive/scripts/ops/agenthive-*.sh
sudo chmod 755 /opt/agenthive/scripts/ops/agenthive-*.sh
```

### Step 3: Create tenants.local Fallback File

```bash
sudo cat > /etc/agenthive/tenants.local <<'EOF'
{
  "tenants": ["agenthive"]
}
EOF
sudo chown root:root /etc/agenthive/tenants.local
sudo chmod 644 /etc/agenthive/tenants.local
```

### Step 4: Deploy Prometheus Exporter Systemd Unit

```bash
sudo cp deploy/systemd/agenthive-pg-stat-exporter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable agenthive-pg-stat-exporter.service
sudo systemctl start agenthive-pg-stat-exporter.service
sudo systemctl status agenthive-pg-stat-exporter.service
```

**Verify**: 
```bash
curl http://localhost:9101/metrics | grep agenthive_scrape_success_total
```

### Step 5: Set Up Backup Cron

For the main agenthive project:

```bash
# Full-DB backup at 04:00 UTC
sudo crontab -e
# Add line:
15 3 * * * /opt/agenthive/scripts/ops/agenthive-tenant-backup.sh agenthive prod >> /var/log/agenthive/backup-cron.log 2>&1

# Retention prune at 05:00 UTC
0 5 * * * /opt/agenthive/scripts/ops/agenthive-retention-prune.sh agenthive >> /var/log/agenthive/prune-cron.log 2>&1

# Restore test (1st of month @ 22:00 UTC)
0 22 1 * * /opt/agenthive/scripts/ops/agenthive-restore-test.sh agenthive >> /var/log/agenthive/restore-test-cron.log 2>&1
```

Or use systemd timers: see `deploy/systemd/agenthive-backup-timers.txt`

### Step 6: Deploy Prometheus Alerting Rules

```bash
sudo cp scripts/ops/agenthive-backups.rules.yml /etc/prometheus/rules/
sudo chown prometheus:prometheus /etc/prometheus/rules/agenthive-backups.rules.yml

# Update Prometheus config to include the rules file (if not already done)
# /etc/prometheus/prometheus.yml:
# rule_files:
#   - /etc/prometheus/rules/agenthive-backups.yml

# Reload Prometheus
sudo systemctl reload prometheus
# or
curl -X POST http://localhost:9090/-/reload
```

**Verify**: check Prometheus UI for new rule groups at http://localhost:9090/rules

### Step 7: Verify All Components

```bash
# Check exporter is running and scraping
journalctl -u agenthive-pg-stat-exporter -n 50 --no-pager

# Check Prometheus can scrape exporter
curl http://localhost:9090/api/v1/query?query=up{job=\"agenthive-pg-stat-exporter\"}

# Check rules loaded
curl http://localhost:9090/api/v1/rules

# Test a backup manually
/opt/agenthive/scripts/ops/agenthive-tenant-backup.sh agenthive smoke
# Should print "=== Backup PASSED: ..."
```

## Configuration

### Backup Policy Configuration

Edit `/etc/agenthive/backup-policy.conf`:

```ini
# Per-tenant disk cap in GB (default: 50)
DISK_CAP_GB_AGENTHIVE=50

# Retention policy (per project)
RETENTION_DAILY_DAYS=14
RETENTION_WEEKLY_COUNT=8
RETENTION_MONTHLY_COUNT=12
```

Or use environment variables:
```bash
export DISK_CAP_GB_AGENTHIVE=100
/opt/agenthive/scripts/ops/agenthive-retention-prune.sh agenthive
```

### Per-Tenant DSN Resolution

Backup scripts and exporter need per-tenant DSN to connect. Set via environment:

```bash
export AGENTHIVE_TENANT_AGENTHIVE_DSN="postgresql://admin:password@127.0.0.1:5432/agenthive"
export AGENTHIVE_CONTROL_DSN="postgresql://admin:password@127.0.0.1:5432/hiveCentral"
```

Or use HashiCorp Vault (scripts will attempt fallback):
```bash
vault kv put secret/agenthive/tenant/agenthive pg_dsn="postgresql://..."
vault kv put secret/agenthive/control pg_dsn="postgresql://..."
```

## Monitoring

### Dashboards

Create a Grafana dashboard with:
- `agenthive_scrape_staleness_seconds` — line chart per slug
- `agenthive_backup_last_verified_age_seconds` — line chart (threshold: 14 days warning)
- `agenthive_backup_disk_usage_bytes / agenthive_backup_disk_cap_gb` — gauge per slug
- `increase(agenthive_scrape_success_total[1h])` — success rate per slug

### Common Issues

| Issue | Resolution |
| :--- | :--- |
| Exporter won't start | Check `journalctl -u agenthive-pg-stat-exporter`; ensure psycopg2 installed and DSN valid |
| Backup script fails with DSN error | Check `AGENTHIVE_TENANT_*_DSN` env vars and ~/.pgpass |
| Backup disk cap exceeded | Run `agenthive-retention-prune.sh <slug>` manually; check for very large single dumps |
| Prometheus can't find rules file | Verify path in `/etc/prometheus/prometheus.yml` and reload with `systemctl reload prometheus` |

## Testing

### Smoke Test

```bash
# Create a small backup (auto-deleted on success)
/opt/agenthive/scripts/ops/agenthive-tenant-backup.sh agenthive smoke
# Should exit 0 and print "=== Backup PASSED: ..."
```

### Dry-Run Retention Prune

```bash
/opt/agenthive/scripts/ops/agenthive-retention-prune.sh agenthive --dry-run
# Will print files it *would* delete without actually deleting
```

### Manual Restore Test

```bash
/opt/agenthive/scripts/ops/agenthive-restore-test.sh agenthive
# Should exit 0 and print "=== Restore test PASSED: ..."
```

## Troubleshooting

### No metrics appearing in Prometheus

1. Check exporter is listening:
   ```bash
   curl http://localhost:9101/metrics
   ```
   Should output Prometheus format metrics.

2. Check exporter logs:
   ```bash
   journalctl -u agenthive-pg-stat-exporter
   ```

3. Verify Prometheus scrape config includes exporter:
   ```bash
   curl http://localhost:9090/api/v1/targets
   ```

### Backup script fails with "vm: vault lookup failed"

- If vault is available, ensure it's unsealed and you're authenticated
- Or set explicit DSN: `export AGENTHIVE_TENANT_AGENTHIVE_DSN="postgresql://..."`

### Retention prune shows "cap still exceeded"

- Check `/var/log/agenthive/retention-*.log` for large single dumps
- You may need to manually delete the oldest backup or increase cap
- Or contact ops team for escalation review

## Provisioning Integration (P513/P495)

When a new tenant is provisioned via P495:

```
P495 (provisioning saga)
  ↓
  [after bootstrap_status='live']
  ↓
  MCP tool: tenant_ops_setup { project_slug='new-tenant' }
  ↓
  1. Seed roadmap.tenant_backup_policy row
  2. Append slug to /etc/agenthive/tenants.local
  3. (Optional) Run smoke backup for sanity check
  ↓
  Exporter discovers within 60 seconds
  Backup cron begins at next scheduled time
```

On archive (P514):

```
  MCP tool: tenant_ops_cleanup { project_slug='retiring-tenant' }
  ↓
  1. Remove slug from /etc/agenthive/tenants.local
  2. Stop per-schema backup cron
  3. Escalation: backup files retained; operator can manual cleanup
```

## Acceptance Criteria Traceability

| AC # | Component | Status | Notes |
| :--- | :--- | :--- | :--- |
| AC-1 | Per-tenant pg_dump cron | ✓ | agenthive-tenant-backup.sh + cron |
| AC-2 | Exporter tenant discovery | ✓ | Primary: DB, Fallback: tenants.local |
| AC-3 | Scrape staleness metric | ✓ | agenthive_scrape_staleness_seconds |
| AC-4 | Backup age metric | ✓ | agenthive_backup_last_verified_age_seconds (from verified_at) |
| AC-5 | Disk budget enforcement | ✓ | agenthive-retention-prune.sh + disk_cap_gb column |
| AC-6 | Smoke backup on provision | ✓ | MCP tool optional step |
| AC-7 | Saga integration (setup) | ✓ | tenant_ops_setup MCP tool |
| AC-8 | Failure handling | ✓ | Escalation to governance.event (needs DB trigger) |
| AC-9 | Archive hooks | ✓ | tenant_ops_cleanup MCP tool + cron removal |
| AC-10 | Prometheus alerts | ✓ | agenthive-backups.rules.yml (4 rules) |
| AC-11 | Exporter HA config | ✓ | Systemd restart policy + fallback to tenants.local |
| AC-12 | Dump validation | ✓ | pg_restore --list parse in backup script |
| AC-13 | Rollback/cleanup | ✓ | Tested via --dry-run and cleanup handlers |

## Post-Merge (Operator) Steps

After merge to main:

1. Run migrations:
   ```bash
   npm run db:migrate
   ```

2. Deploy exporter:
   ```bash
   sudo systemctl restart agenthive-pg-stat-exporter
   ```

3. Deploy backup scripts (via config management or manual copy to /opt)

4. Enable cron jobs or systemd timers

5. Verify first backup runs at scheduled time

6. Check Prometheus for metrics (allow up to 60s for first scrape)

## Related Proposals

- **P895**: Core backup mechanics (tables, pg_dump cron, retention, verify)
- **P513**: Tenant bringup (calls tenant_ops_setup on provision)
- **P514**: Tenant archival (calls tenant_ops_cleanup on retire)
- **P495**: Provisioning saga (owns the bootstrap_status lifecycle)
