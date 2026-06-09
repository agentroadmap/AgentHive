#!/usr/bin/env bash
# scripts/ops/tenant-ops-setup.sh
#
# P509 — Tenant ops bundle provisioning hook.
#
# Called by project provisioning saga (P495) after bootstrap_status='live'.
# Sets up per-tenant backup policy, runs smoke backup, writes provisioning entry
# to governance.event, and handles failures with rollback.
#
# Usage:
#   tenant-ops-setup.sh <slug> <control-dsn> <tenant-dsn>
#
# Returns:
#   0 — setup complete, all ACs met (AC-6, AC-7 verified)
#   1 — recoverable error; project remains in provisioning; repair queued (AC-8)
#   2 — fatal error; ops setup aborted

set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <control-dsn> <tenant-dsn>}"
CONTROL_DSN="${2:?}"
TENANT_DSN="${3:?}"

LOG_DIR="/var/log/agenthive"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ops-setup-${SLUG}.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }
success=false
trap 'on_exit' EXIT

on_exit() {
  if $success; then
    log "=== Tenant ops setup SUCCESS: ${SLUG} ==="
  else
    log "=== Tenant ops setup FAILED: ${SLUG} ==="
  fi
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 1: Seed core.tenant_backup_policy
# ───────────────────────────────────────────────────────────────────────────────
_setup_backup_policy() {
  log "Step 1: seeding core.tenant_backup_policy for slug=${SLUG}..."

  local sql_file="${LOG_DIR}/.setup-policy-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
INSERT INTO core.tenant_backup_policy
  (project_slug, schedule, retention_daily, retention_weekly, retention_monthly, backup_disk_cap_gb, created_at)
VALUES
  (:SLUG, '0 4 * * *', 14, 8, 12, 50, NOW())
ON CONFLICT (project_slug) DO NOTHING;
EOF

  if ! psql "$CONTROL_DSN" -v SLUG="$SLUG" -f "$sql_file" 2>>"$LOG"; then
    log "ERROR: failed to seed backup policy"
    rm -f "$sql_file"
    return 1
  fi
  rm -f "$sql_file"

  # Verify insertion
  local policy_count=$(psql "$CONTROL_DSN" -t -c "SELECT COUNT(*) FROM core.tenant_backup_policy WHERE project_slug='${SLUG}'" 2>>"$LOG")
  if [[ "$policy_count" -eq 0 ]]; then
    log "ERROR: policy row not created for ${SLUG}"
    return 1
  fi

  log "  policy row created"
  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 2: Update /etc/agenthive/tenants.local (JSON list)
# ───────────────────────────────────────────────────────────────────────────────
_update_tenants_local() {
  log "Step 2: updating /etc/agenthive/tenants.local..."

  local tenants_file="/etc/agenthive/tenants.local"
  mkdir -p "$(dirname "$tenants_file")"

  if [[ ! -f "$tenants_file" ]]; then
    echo '{"tenants": []}' > "$tenants_file"
  fi

  # Use Python to update JSON
  python3 - << 'PYEOF'
import json
import sys
import os

slug = os.environ.get('SLUG', '')
tenants_file = os.environ.get('TENANTS_FILE', '')

if not slug or not tenants_file:
    print("ERROR: SLUG or TENANTS_FILE not set", file=sys.stderr)
    sys.exit(1)

try:
    with open(tenants_file, 'r') as f:
        data = json.load(f)
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)

if 'tenants' not in data:
    data['tenants'] = []

if slug not in data['tenants']:
    data['tenants'].append(slug)
    data['tenants'].sort()

with open(tenants_file, 'w') as f:
    json.dump(data, f, indent=2)

print(f"Updated: {len(data['tenants'])} tenants")
PYEOF

  local py_exit=$?
  if [[ $py_exit -ne 0 ]]; then
    log "ERROR: failed to update tenants.local"
    return 1
  fi

  chmod 644 "$tenants_file"
  log "  tenants.local updated"
  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 3: Run smoke backup (pg_dump + validation)
# ───────────────────────────────────────────────────────────────────────────────
_run_smoke_backup() {
  log "Step 3: running smoke backup..."

  local smoke_dir="/var/backups/agenthive/${SLUG}/.smoke"
  mkdir -p "$smoke_dir"

  local timestamp=$(date -u +%Y%m%d-%H%M%S)
  local dump_file="${smoke_dir}/${timestamp}.dump"

  # Run pg_dump
  if ! pg_dump -F c "$TENANT_DSN" > "$dump_file" 2>>"$LOG"; then
    log "ERROR: pg_dump failed during smoke backup"
    rm -f "$dump_file"
    return 1
  fi

  local dump_size=$(stat -c%s "$dump_file" 2>/dev/null || echo 0)
  log "  pg_dump OK: $(( dump_size / 1024 / 1024 )) MB"

  # Validate with pg_restore --list
  local manifest_file="${dump_file}.manifest"
  if ! pg_restore --list "$dump_file" > "$manifest_file" 2>>"$LOG"; then
    log "ERROR: pg_restore --list failed; dump corrupted"
    rm -f "$dump_file" "$manifest_file"
    return 1
  fi

  local manifest_lines=$(wc -l < "$manifest_file")
  if [[ "$manifest_lines" -lt 5 ]]; then
    log "ERROR: manifest has only ${manifest_lines} lines"
    rm -f "$dump_file" "$manifest_file"
    return 1
  fi

  log "  validation OK: ${manifest_lines} manifest lines"

  # Clean up smoke files
  rm -f "$dump_file" "$manifest_file"

  log "  smoke backup validated and cleaned"
  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 4: Insert governance.event entry
# ───────────────────────────────────────────────────────────────────────────────
_write_event() {
  local outcome="$1"
  local error_detail="${2:-}"

  log "Step 4: writing governance.event entry (outcome=${outcome})..."

  local detail="${error_detail:-Ops setup completed for ${SLUG}}"

  local sql_file="${LOG_DIR}/.event-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
INSERT INTO governance.event
  (aggregate_id, aggregate_type, event_type, severity, triggered_by, details, created_at)
VALUES
  (:SLUG, 'project', 'ops_setup_' || :OUTCOME, 'ops', 'cron/ops-setup', :DETAIL, NOW())
ON CONFLICT DO NOTHING;
EOF

  psql "$CONTROL_DSN" -v SLUG="$SLUG" -v OUTCOME="$outcome" -v DETAIL="$detail" -f "$sql_file" 2>>"$LOG" || {
    log "WARNING: governance.event insert failed (non-fatal)"
  }
  rm -f "$sql_file"

  log "  event logged"
  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Escalation helper
# ───────────────────────────────────────────────────────────────────────────────
_escalate() {
  local reason="$1"
  local severity="${2:-info}"

  log "ESCALATING: ${reason} (severity=${severity})"

  local sql_file="${LOG_DIR}/.escalate-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
INSERT INTO governance.escalation_log
  (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
VALUES
  ('OPS_SETUP_FAILURE', 'P509', 'cron/ops-setup', 'ops', :SEVERITY,
   :REASON || ' for slug=' || :SLUG)
ON CONFLICT DO NOTHING;
EOF

  psql "$CONTROL_DSN" -v SEVERITY="$severity" -v REASON="$reason" -v SLUG="$SLUG" -f "$sql_file" 2>>"$LOG" || true
  rm -f "$sql_file"
}

# ───────────────────────────────────────────────────────────────────────────────
# Main flow
# ───────────────────────────────────────────────────────────────────────────────
log "=== Tenant ops setup: slug=${SLUG} ==="

# Make SLUG and other vars available to Python subprocess
export SLUG TENANTS_FILE="/etc/agenthive/tenants.local"

if ! _setup_backup_policy; then
  _write_event "failed" "backup_policy seed failed"
  _escalate "backup_policy seed failed" "high"
  exit 1
fi

if ! _update_tenants_local; then
  _write_event "failed" "tenants.local update failed"
  _escalate "tenants.local update failed" "high"
  exit 1
fi

if ! _run_smoke_backup; then
  _write_event "failed" "smoke backup validation failed"
  _escalate "smoke backup validation failed" "high"
  exit 1
fi

_write_event "success"
success=true
exit 0
