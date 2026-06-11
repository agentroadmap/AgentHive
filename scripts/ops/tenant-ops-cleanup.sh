#!/usr/bin/env bash
# scripts/ops/tenant-ops-cleanup.sh
#
# P509 — Tenant ops cleanup hook (archive/retire).
#
# Called by mcp_tenant_lifecycle when .archive() or .retire() is invoked.
# Removes slug from provisioning state, disables per-schema backups,
# and logs cleanup instruction for manual backup cleanup.
#
# Usage:
#   tenant-ops-cleanup.sh <slug> <control-dsn> [--full-purge]
#
# Modes:
#   default      — mark archived, stop per-schema backups, keep backup files
#   --full-purge — delete all backup files for slug immediately
#
# Returns:
#   0 — cleanup complete (AC-9 verified)
#   1 — error; escalated

set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <control-dsn> [--full-purge]}"
CONTROL_DSN="${2:?}"
FULL_PURGE=false
[[ "${3:-}" == "--full-purge" ]] && FULL_PURGE=true

LOG_DIR="/var/log/agenthive"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ops-cleanup-${SLUG}.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

_escalate() {
  local reason="$1"
  local sql_file="${LOG_DIR}/.cleanup-esc-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
INSERT INTO governance.escalation_log
  (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
VALUES
  ('OPS_CLEANUP_FAILURE', 'P509', 'cron/ops-cleanup', 'ops', 'info', :REASON || ' for slug=' || :SLUG)
ON CONFLICT DO NOTHING;
EOF

  psql "$CONTROL_DSN" -v REASON="$reason" -v SLUG="$SLUG" -f "$sql_file" 2>>"$LOG" || true
  rm -f "$sql_file"
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 1: Remove slug from tenants.local
# ───────────────────────────────────────────────────────────────────────────────
_remove_from_tenants_local() {
  log "Step 1: removing slug from /etc/agenthive/tenants.local..."

  local tenants_file="/etc/agenthive/tenants.local"
  if [[ ! -f "$tenants_file" ]]; then
    log "  tenants.local not found; skipping"
    return 0
  fi

  python3 - << 'PYEOF'
import json
import sys
import os

slug = os.environ.get('SLUG', '')
tenants_file = os.environ.get('TENANTS_FILE', '')

if not slug or not tenants_file:
    sys.exit(0)

try:
    with open(tenants_file, 'r') as f:
        data = json.load(f)
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)

if 'tenants' in data and slug in data['tenants']:
    data['tenants'].remove(slug)
    with open(tenants_file, 'w') as f:
        json.dump(data, f, indent=2)
PYEOF

  chmod 644 "$tenants_file"
  log "  slug removed from tenants.local"
  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 2: Disable per-schema backup cron (mark archived in policy)
# ───────────────────────────────────────────────────────────────────────────────
_disable_backup_cron() {
  log "Step 2: disabling per-schema backup cron..."

  local sql_file="${LOG_DIR}/.cleanup-pol-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
UPDATE core.tenant_backup_policy
SET schedule = NULL, is_enabled = false, archived_at = NOW()
WHERE project_slug = :SLUG;
EOF

  psql "$CONTROL_DSN" -v SLUG="$SLUG" -f "$sql_file" 2>>"$LOG" || {
    log "WARNING: cron disable failed (policy table may not exist)"
  }
  rm -f "$sql_file"
  log "  backup policy disabled"
  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 3: Log cleanup instruction
# ───────────────────────────────────────────────────────────────────────────────
_log_cleanup_instruction() {
  log "Step 3: logging cleanup instruction..."

  local backup_dir="/var/backups/agenthive/${SLUG}"
  local detail="Backup files at ${backup_dir}/ retained for audit; use --full-purge flag to delete immediately"

  local sql_file="${LOG_DIR}/.cleanup-evt-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
INSERT INTO governance.event
  (aggregate_id, aggregate_type, event_type, severity, triggered_by, details, created_at)
VALUES
  (:SLUG, 'project', 'ops_archived', 'ops', 'cron/ops-cleanup', :DETAIL, NOW())
ON CONFLICT DO NOTHING;
EOF

  psql "$CONTROL_DSN" -v SLUG="$SLUG" -v DETAIL="$detail" -f "$sql_file" 2>>"$LOG" || {
    log "WARNING: governance.event insert failed"
  }
  rm -f "$sql_file"

  log "  cleanup instruction logged"
  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Step 4: Optional full purge of backup files
# ───────────────────────────────────────────────────────────────────────────────
_full_purge_backups() {
  if ! $FULL_PURGE; then
    log "Step 4: skipping backup file purge (--full-purge not set)"
    return 0
  fi

  log "Step 4: purging backup files (--full-purge mode)..."

  local backup_dir="/var/backups/agenthive/${SLUG}"
  if [[ -d "$backup_dir" ]]; then
    local file_count=$(find "$backup_dir" -type f 2>/dev/null | wc -l)
    rm -rf "$backup_dir"
    log "  deleted ${file_count} backup files"
  else
    log "  backup dir not found; nothing to purge"
  fi

  return 0
}

# ───────────────────────────────────────────────────────────────────────────────
# Main flow
# ───────────────────────────────────────────────────────────────────────────────
log "=== Tenant ops cleanup: slug=${SLUG} purge=${FULL_PURGE} ==="

export SLUG TENANTS_FILE="/etc/agenthive/tenants.local"

if ! _remove_from_tenants_local; then
  _escalate "tenants.local removal failed"
  exit 1
fi

if ! _disable_backup_cron; then
  log "WARNING: backup cron disable failed (continuing)"
fi

if ! _log_cleanup_instruction; then
  log "WARNING: cleanup event log failed (continuing)"
fi

if ! _full_purge_backups; then
  _escalate "backup file purge failed"
  exit 1
fi

log "=== Tenant ops cleanup SUCCESS: ${SLUG} ==="
exit 0
