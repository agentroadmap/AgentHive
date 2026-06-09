# P509 — Tenant DB Ops Bundle Install Runbook

**Operator Manual for Per-Tenant Backup Monitoring, Disk Budget Enforcement, and Provisioning/Archive Saga Integration**

## Overview

P509 provides the complete tenant operations suite for AgentHive2:

- **Backup Monitoring**: Prometheus exporter metrics for per-tenant backup staleness and disk usage
- **Disk Budget Enforcement**: Automatic oldest-first pruning when per-tenant backup_disk_cap_gb is exceeded
- **Provisioning Integration**: Post-bootstrap setup hook (tenant-ops-setup.sh) called by P495 provisioning saga
- **Archive/Cleanup**: Archive and retire hooks (tenant-ops-cleanup.sh) for mcp_tenant_lifecycle operations
- **Alerting Rules**: Prometheus alerting for staleness, disk usage, and cap exceeded scenarios

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Tenant Provisioning Saga (P495)                             │
│  ├─ bootstrap_status='live' → tenant-ops-setup.sh           │
│  │   ├─ Seed core.tenant_backup_policy                      │
│  │   ├─ Update /etc/agenthive/tenants.local                 │
│  │   ├─ Run smoke backup (pg_dump + pg_restore --list)      │
│  │   └─ Write governance.event (success/failure)            │
│  └─ Write governance.escalation_log on failure              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Per-Tenant Backup Cron (P895)                               │
│  ├─ 0 4 * * * — pg_dump (custom.backup_postgres)           │
│  ├─ Post-backup → disk-budget-enforce.sh                    │
│  │   ├─ Query core.tenant_backup_policy.backup_disk_cap_gb  │
│  │   ├─ If over cap → delete oldest .dump files (FIFO)      │
│  │   └─ Write governance.event (cap_warning/cap_enforced)   │
│  └─ Post-failure → Write governance.escalation_log          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Prometheus Exporter (agenthive-pg-stat-exporter)            │
│  ├─ :9101/metrics scrape every 60s                          │
│  ├─ Tenant discovery from /etc/agenthive/tenants.local      │
│  ├─ Metrics:                                                │
│  │   ├─ agenthive_backup_last_verified_age_seconds          │
│  │   ├─ agenthive_backup_disk_usage_bytes                   │
│  │   ├─ agenthive_scrape_staleness_seconds                  │
│  │   └─ agenthive_backup_disk_cap_gb                        │
│  ├─ HA Config: Restart=always, RestartSec=5, max-burst=10/60s
│  └─ Fallback discovery: tenants.local if DB unavailable     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Prometheus Alerting Rules (agenthive-backups.rules.yml)     │
│  ├─ AgentHiveBackupStaleness (warn >9 days, crit >14 days)  │
│  ├─ AgentHiveScrapeStaleness (warn >300s, crit >600s)       │
│  ├─ AgentHiveBackupDiskUsageHigh (<15% /var available)      │
│  └─ AgentHiveBackupCapExceeded (cap enforcement failed)     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Archive/Retire Saga (mcp_tenant_lifecycle)                  │
│  ├─ .archive() / .retire() → tenant-ops-cleanup.sh          │
│  │   ├─ Remove slug from /etc/agenthive/tenants.local       │
│  │   ├─ Disable per-schema backup cron (policy.schedule=NULL)
│  │   ├─ Write governance.event (ops_archived)               │
│  │   └─ Optional --full-purge to delete backup files        │
│  └─ Write governance.escalation_log on failure              │
└─────────────────────────────────────────────────────────────┘
```

## Installation Steps

### Step 1: Create agenthive system user (if not already present)

```bash
sudo useradd -r -s /bin/bash -d /var/lib/agenthive -m agenthive 2>/dev/null || true
sudo usermod -aG sudo agenthive  # for systemd service sudo requirements
sudo mkdir -p /etc/agenthive /var/log/agenthive /var/backups/agenthive
sudo chown -R agenthive:agenthive /etc/agenthive /var/log/agenthive /var/backups/agenthive
sudo chmod 755 /etc/agenthive /var/log/agenthive /var/backups/agenthive
```

### Step 2: Install Python dependencies (agenthive-pg-stat-exporter)

The exporter requires psycopg2 (PostgreSQL adapter) and prometheus-client:

```bash
sudo apt-get update
sudo apt-get install -y python3-dev python3-pip
sudo pip3 install psycopg2-binary prometheus-client

# Verify installation
python3 -c "import psycopg2; import prometheus_client; print('OK')"
```

### Step 3: Deploy tenant ops scripts

Copy the three provisioning/enforcement/cleanup scripts to the system path:

```bash
sudo cp scripts/ops/tenant-ops-setup.sh /usr/local/bin/tenant-ops-setup.sh
sudo cp scripts/ops/disk-budget-enforce.sh /usr/local/bin/disk-budget-enforce.sh
sudo cp scripts/ops/tenant-ops-cleanup.sh /usr/local/bin/tenant-ops-cleanup.sh

sudo chmod 755 /usr/local/bin/tenant-ops-setup.sh
sudo chmod 755 /usr/local/bin/disk-budget-enforce.sh
sudo chmod 755 /usr/local/bin/tenant-ops-cleanup.sh

# Verify scripts are executable
ls -lh /usr/local/bin/tenant-ops-*.sh /usr/local/bin/disk-budget-*.sh
```

### Step 4: Deploy agenthive-pg-stat-exporter.py (already exists)

The exporter script should already be installed at `/usr/local/bin/agenthive-pg-stat-exporter.py` from P895.

Verify it exists:
```bash
ls -lh /usr/local/bin/agenthive-pg-stat-exporter.py
python3 /usr/local/bin/agenthive-pg-stat-exporter.py --version 2>/dev/null || echo "Exporter not yet installed"
```

### Step 5: Deploy and enable agenthive-pg-stat-exporter.service

Template: `scripts/ops/agenthive-pg-stat-exporter.service.template`

**Step 5a: Substitute DSN and deploy systemd service**

```bash
# Get the control DSN from your deployment config
export AGENTHIVE_CONTROL_DSN="postgresql://agenthive:PASSWORD@localhost:5432/agenthive_control"

# Substitute DSN into template and deploy to systemd
sudo sed "s|{{AGENTHIVE_CONTROL_DSN}}|${AGENTHIVE_CONTROL_DSN}|g" \
  scripts/ops/agenthive-pg-stat-exporter.service.template \
  > /tmp/agenthive-pg-stat-exporter.service

sudo cp /tmp/agenthive-pg-stat-exporter.service \
  /etc/systemd/system/agenthive-pg-stat-exporter.service

sudo systemctl daemon-reload
sudo systemctl enable agenthive-pg-stat-exporter.service
sudo systemctl start agenthive-pg-stat-exporter.service

# Verify service is running
sudo systemctl status agenthive-pg-stat-exporter.service
```

**Step 5b: Verify exporter health**

```bash
# Wait 5 seconds for first scrape
sleep 5

# Check metrics are being produced
curl -s http://localhost:9101/metrics | grep agenthive_backup

# Expected output:
# agenthive_backup_last_verified_age_seconds{slug="..."} 0
# agenthive_backup_disk_usage_bytes{slug="..."} 0
# agenthive_scrape_staleness_seconds{slug="..."} 0
```

### Step 6: Deploy Prometheus alerting rules

Copy the alerting rules to Prometheus:

```bash
sudo cp scripts/ops/agenthive-backups.rules.yml \
  /etc/prometheus/rules/agenthive-backups.yml

sudo chown prometheus:prometheus /etc/prometheus/rules/agenthive-backups.yml
sudo chmod 644 /etc/prometheus/rules/agenthive-backups.yml

# Verify Prometheus rule syntax
promtool check rules /etc/prometheus/rules/agenthive-backups.yml

# Reload Prometheus rules
sudo systemctl reload prometheus
# OR: curl -X POST http://localhost:9090/-/reload
```

### Step 7: Set up backup cron integration (post-P895 backup runs)

The disk-budget-enforce.sh hook is called by the backup cron (P895) AFTER each pg_dump completes.

**Step 7a: Verify backup cron policy**

```sql
-- Connect to control plane DB
psql $AGENTHIVE_CONTROL_DSN

-- Verify core.tenant_backup_policy table exists
SELECT table_name FROM information_schema.tables 
WHERE table_schema='core' AND table_name='tenant_backup_policy';

-- Verify per-tenant default policies are seeded
SELECT project_slug, schedule, retention_daily, retention_weekly, 
       retention_monthly, backup_disk_cap_gb 
FROM core.tenant_backup_policy LIMIT 5;
```

**Step 7b: Register disk-budget-enforce.sh hook in backup cron (P895)**

The P895 backup saga calls disk-budget-enforce.sh as a post-backup hook:

```bash
# In the backup cron (custom.backup_postgres), after pg_dump completes:
/usr/local/bin/disk-budget-enforce.sh "$SLUG" "$CONTROL_DSN" --threshold-percent 85
```

## Integration Points

### Provisioning Saga (P495)

When a tenant is provisioned:

```sql
-- Triggered by P495 saga after bootstrap_status='live'
-- Calls: /usr/local/bin/tenant-ops-setup.sh $SLUG $CONTROL_DSN $TENANT_DSN

-- The script will:
-- 1. INSERT core.tenant_backup_policy (project_slug, schedule='0 4 * * *', cap=50GB)
-- 2. UPDATE /etc/agenthive/tenants.local (add slug to JSON list)
-- 3. Run pg_dump -F c && pg_restore --list (smoke backup validation)
-- 4. INSERT governance.event (ops_setup_success or ops_setup_failed)

-- Returns: 0 = success, 1 = failure (escalated), 2 = fatal error
```

**Success criteria (AC-6):**
- core.tenant_backup_policy row exists for the slug
- Policy has non-null values: schedule='0 4 * * *', retention_daily=14, cap=50GB

**Smoke backup validation (AC-7):**
- pg_dump completes without error
- pg_restore --list validates the dump structure
- Manifest contains at least 5 lines (basic schema existence)

**Governance event (AC-8):**
- ops_setup_success event written on success
- ops_setup_failed event + escalation on failure

### Archive/Retire Saga (mcp_tenant_lifecycle)

When a tenant is archived or retired:

```bash
# Triggered by mcp_tenant_lifecycle.archive() or .retire()
# Calls: /usr/local/bin/tenant-ops-cleanup.sh $SLUG $CONTROL_DSN [--full-purge]

# The script will:
# 1. REMOVE slug from /etc/agenthive/tenants.local
# 2. UPDATE core.tenant_backup_policy SET is_enabled=false, archived_at=NOW()
# 3. INSERT governance.event (ops_archived)
# 4. (Optional) DELETE backup files at /var/backups/agenthive/$SLUG/*
```

**Cleanup verification (AC-9):**
- slug removed from tenants.local
- policy.is_enabled=false, archived_at is NOT NULL
- governance.event logged

**Full purge mode:**
```bash
/usr/local/bin/tenant-ops-cleanup.sh $SLUG $CONTROL_DSN --full-purge
# Deletes all backup files for the slug and subdirectories
```

## Testing & Validation

### Manual Test: Disk Budget Enforcement

Simulate exceeding backup cap:

```bash
# Create test directory
TEST_SLUG="test-tenant-12345"
TEST_BACKUP_DIR="/var/backups/agenthive/${TEST_SLUG}"
mkdir -p "$TEST_BACKUP_DIR"

# Create dummy backup files (100MB each)
dd if=/dev/zero of="$TEST_BACKUP_DIR/backup-1.dump" bs=1M count=100
dd if=/dev/zero of="$TEST_BACKUP_DIR/backup-2.dump" bs=1M count=100
dd if=/dev/zero of="$TEST_BACKUP_DIR/backup-3.dump" bs=1M count=100

# Insert policy with small cap (200MB = 0.2GB)
psql "$AGENTHIVE_CONTROL_DSN" << 'EOF'
INSERT INTO core.tenant_backup_policy 
  (project_slug, schedule, retention_daily, retention_weekly, retention_monthly, 
   backup_disk_cap_gb, created_at)
VALUES 
  ('test-tenant-12345', NULL, 14, 8, 12, 0.2, NOW())
ON CONFLICT (project_slug) DO UPDATE SET backup_disk_cap_gb = 0.2;
EOF

# Run disk budget enforcement
/usr/local/bin/disk-budget-enforce.sh "$TEST_SLUG" "$AGENTHIVE_CONTROL_DSN" --threshold-percent 85

# Expected: At least one file deleted, final usage < 0.2GB
# Verify: oldest file (backup-1.dump) should be missing
ls -lh "$TEST_BACKUP_DIR/"

# Clean up
rm -rf "$TEST_BACKUP_DIR"
psql "$AGENTHIVE_CONTROL_DSN" -c "DELETE FROM core.tenant_backup_policy WHERE project_slug='test-tenant-12345';"
```

### Manual Test: Provisioning Hook

Test the post-bootstrap provisioning sequence:

```bash
TEST_SLUG="provisioning-test-$(date +%s)"
CONTROL_DSN="$AGENTHIVE_CONTROL_DSN"
TENANT_DSN="postgresql://test_user:test_pass@localhost:5432/test_tenant"

# Run provisioning setup
/usr/local/bin/tenant-ops-setup.sh "$TEST_SLUG" "$CONTROL_DSN" "$TENANT_DSN"

# Expected return codes:
# 0 = success (all ACs met)
# 1 = recoverable error (policy seed failed, policy row not created, etc.)
# 2 = fatal error (can't execute smoke backup)

# Verify policy was seeded
psql "$CONTROL_DSN" -c \
  "SELECT project_slug, schedule, retention_daily, backup_disk_cap_gb 
   FROM core.tenant_backup_policy WHERE project_slug='$TEST_SLUG';"

# Verify tenants.local was updated
grep "$TEST_SLUG" /etc/agenthive/tenants.local

# Verify governance.event was logged
psql "$CONTROL_DSN" -c \
  "SELECT event_type, details FROM governance.event 
   WHERE aggregate_id='$TEST_SLUG' AND event_type LIKE 'ops_setup_%' 
   ORDER BY created_at DESC LIMIT 1;"
```

### Manual Test: Archive/Cleanup Hook

Test the archive sequence:

```bash
TEST_SLUG="archive-test-$(date +%s)"
CONTROL_DSN="$AGENTHIVE_CONTROL_DSN"

# Create test backup directory with a file
TEST_BACKUP_DIR="/var/backups/agenthive/${TEST_SLUG}"
mkdir -p "$TEST_BACKUP_DIR"
echo "test backup" > "$TEST_BACKUP_DIR/test.dump"

# Seed tenants.local and policy
python3 - << 'PYEOF'
import json
import os

slug = os.environ['TEST_SLUG']
tenants_file = '/etc/agenthive/tenants.local'

with open(tenants_file, 'r') as f:
    data = json.load(f)

if slug not in data['tenants']:
    data['tenants'].append(slug)
    data['tenants'].sort()

with open(tenants_file, 'w') as f:
    json.dump(data, f, indent=2)
PYEOF

psql "$CONTROL_DSN" << "EOF"
INSERT INTO core.tenant_backup_policy (project_slug, schedule, created_at)
VALUES ('$TEST_SLUG', NULL, NOW())
ON CONFLICT DO NOTHING;
EOF

# Run cleanup (without full purge)
/usr/local/bin/tenant-ops-cleanup.sh "$TEST_SLUG" "$CONTROL_DSN"

# Verify slug was removed from tenants.local
! grep -q "$TEST_SLUG" /etc/agenthive/tenants.local && echo "Slug removed: OK"

# Verify policy was disabled
psql "$CONTROL_DSN" -c \
  "SELECT is_enabled, archived_at FROM core.tenant_backup_policy WHERE project_slug='$TEST_SLUG';" \
  | grep "f |" && echo "Policy disabled: OK"

# Verify governance.event was logged
psql "$CONTROL_DSN" -c \
  "SELECT event_type FROM governance.event WHERE aggregate_id='$TEST_SLUG' AND event_type='ops_archived';" \
  | grep -q ops_archived && echo "Event logged: OK"

# Verify backup files are still present (no full-purge)
[[ -f "$TEST_BACKUP_DIR/test.dump" ]] && echo "Backup files retained: OK"

# Now test full purge
/usr/local/bin/tenant-ops-cleanup.sh "$TEST_SLUG" "$CONTROL_DSN" --full-purge

# Verify backup files were deleted
[[ ! -d "$TEST_BACKUP_DIR" ]] && echo "Backup files deleted: OK"
```

## Troubleshooting

### Issue: Exporter service fails to start

```bash
sudo systemctl status agenthive-pg-stat-exporter.service
sudo journalctl -u agenthive-pg-stat-exporter.service -n 20
```

**Common causes:**

- **DSN not substituted**: Check `/etc/systemd/system/agenthive-pg-stat-exporter.service` for `{{AGENTHIVE_CONTROL_DSN}}` placeholder (not substituted)
- **Python dependencies missing**: `pip3 install psycopg2-binary prometheus-client`
- **Database not running**: Verify PostgreSQL is accessible at DSN
- **Permission denied**: Ensure agenthive user owns `/var/log/agenthive`

### Issue: Missing tenants in exporter metrics

```bash
# Check tenants.local file
cat /etc/agenthive/tenants.local

# Verify JSON is valid
python3 -c "import json; json.load(open('/etc/agenthive/tenants.local'))" && echo "Valid JSON"

# Check exporter logs
sudo journalctl -u agenthive-pg-stat-exporter.service -n 50 | grep -i "tenant\|discovery"
```

**Common causes:**

- **Tenants not seeded**: Run provisioning setup for each tenant
- **File permissions**: Check `/etc/agenthive/tenants.local` is world-readable
- **DB unavailable**: Exporter will fall back to tenants.local after 5 failed scrapes

### Issue: Prometheus alerting rules fail to validate

```bash
promtool check rules /etc/prometheus/rules/agenthive-backups.yml
```

**Common causes:**

- **YAML syntax error**: Check indentation and colons
- **Invalid PromQL expressions**: Verify metric names exist (e.g., `agenthive_backup_last_verified_age_seconds`)
- **Prometheus version mismatch**: Some alert syntax requires newer Prometheus (check version)

### Issue: Disk budget enforcement not deleting files

```bash
# Check logs
tail -50 /var/log/agenthive/disk-enforce-${SLUG}.log

# Verify permissions
ls -lhd /var/backups/agenthive/${SLUG}
ls -lh /var/backups/agenthive/${SLUG}/*.dump 2>/dev/null | head -5
```

**Common causes:**

- **Files owned by different user**: Check file ownership
- **Disk quota hit**: Verify disk space with `df -h /var`
- **Policy cap not set**: Verify `core.tenant_backup_policy.backup_disk_cap_gb` is NOT NULL

## Rollback / Disabling P509

To disable P509 and revert to pre-bundle state:

```bash
# 1. Stop the exporter
sudo systemctl stop agenthive-pg-stat-exporter.service
sudo systemctl disable agenthive-pg-stat-exporter.service
sudo rm /etc/systemd/system/agenthive-pg-stat-exporter.service
sudo systemctl daemon-reload

# 2. Remove alerting rules
sudo rm /etc/prometheus/rules/agenthive-backups.yml
sudo systemctl reload prometheus

# 3. Remove scripts
sudo rm /usr/local/bin/tenant-ops-setup.sh
sudo rm /usr/local/bin/disk-budget-enforce.sh
sudo rm /usr/local/bin/tenant-ops-cleanup.sh

# 4. Keep backup policy data in DB (audit trail)
# Do NOT delete core.tenant_backup_policy rows

# 5. Verify removal
systemctl list-unit-files | grep agenthive-pg-stat-exporter  # should be empty
ls /etc/prometheus/rules/agenthive-*.yml  # should not include agenthive-backups.yml
ls /usr/local/bin/tenant-ops-*.sh  # should be empty
```

## Verification Checklist

After installation, verify:

- [ ] `sudo systemctl status agenthive-pg-stat-exporter.service` = `active (running)`
- [ ] `curl -s http://localhost:9101/metrics | grep agenthive_backup` = metrics present
- [ ] `psql $AGENTHIVE_CONTROL_DSN -c "SELECT COUNT(*) FROM core.tenant_backup_policy"` > 0
- [ ] `cat /etc/agenthive/tenants.local | python3 -m json.tool` = valid JSON
- [ ] `promtool check rules /etc/prometheus/rules/agenthive-backups.yml` = no errors
- [ ] `grep -c "alert:" /etc/prometheus/rules/agenthive-backups.yml` = 4 alerts
- [ ] Log files writable: `touch /var/log/agenthive/test.log && rm /var/log/agenthive/test.log`
- [ ] Backup directory writable: `touch /var/backups/agenthive/test.dump && rm /var/backups/agenthive/test.dump`

## References

- **P509 Acceptance Criteria**: See proposal in roadmap; all 13 ACs documented in this runbook
- **P895**: Backup mechanics (pg_dump cron, retention, verify cron)
- **P495**: Tenant provisioning saga (bootstrap integration)
- **mcp_tenant_lifecycle**: Archive/retire saga (cleanup integration)
- **CONVENTIONS.md**: Database topology and governance event logging
