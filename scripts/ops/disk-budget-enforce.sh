#!/usr/bin/env bash
# scripts/ops/disk-budget-enforce.sh
#
# P509 — Per-tenant disk budget enforcement with oldest-first pruning.
#
# Runs as post-backup hook (after each pg_dump completes).
# Checks actual disk usage against core.tenant_backup_policy.backup_disk_cap_gb,
# deletes oldest .dump files first if over cap, and writes governance event.
#
# Usage:
#   disk-budget-enforce.sh <slug> <control-dsn> [--threshold-percent]
#
# Arguments:
#   slug                  — project slug
#   control-dsn           — DSN for governance.event writes
#   --threshold-percent   — warn at % of cap (default: 85); delete at 100%
#
# Returns:
#   0 — under cap or successfully pruned to cap
#   1 — cap exceeded and pruning failed; escalated
#   2 — error reading policy or disk info

set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <control-dsn> [--threshold-percent]}"
CONTROL_DSN="${2:?}"
WARN_THRESHOLD="${3:-85}"

LOG_DIR="/var/log/agenthive"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/disk-enforce-${SLUG}.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

# ───────────────────────────────────────────────────────────────────────────────
# Fetch policy from DB
# ───────────────────────────────────────────────────────────────────────────────
_get_disk_cap_gb() {
  psql "$CONTROL_DSN" -t -c \
    "SELECT COALESCE(backup_disk_cap_gb, 50) FROM core.tenant_backup_policy WHERE project_slug='${SLUG}' LIMIT 1" \
    2>/dev/null || echo 50
}

# ───────────────────────────────────────────────────────────────────────────────
# Helper: emit governance event
# ───────────────────────────────────────────────────────────────────────────────
_write_event() {
  local event_type="$1"
  local detail="$2"

  local sql_file="${LOG_DIR}/.event-enforce-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
INSERT INTO governance.event
  (aggregate_id, aggregate_type, event_type, severity, triggered_by, details, created_at)
VALUES
  (:SLUG, 'project', :ETYPE, 'ops', 'cron/disk-enforce', :DETAIL, NOW())
ON CONFLICT DO NOTHING;
EOF

  psql "$CONTROL_DSN" -v SLUG="$SLUG" -v ETYPE="$event_type" -v DETAIL="$detail" -f "$sql_file" 2>>"$LOG" || true
  rm -f "$sql_file"
}

# ───────────────────────────────────────────────────────────────────────────────
# Helper: emit escalation if still over cap
# ───────────────────────────────────────────────────────────────────────────────
_escalate_over_cap() {
  local usage_gb="$1"
  local cap_gb="$2"

  local sql_file="${LOG_DIR}/.esc-enforce-${SLUG}.sql"
  cat > "$sql_file" << 'EOF'
INSERT INTO governance.escalation_log
  (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
VALUES
  ('BACKUP_DISK_CAP_EXCEEDED', 'P509', 'cron/disk-enforce', 'ops', 'high',
   'Tenant ' || :SLUG || ': usage ' || :USAGE || 'GB > cap ' || :CAP || 'GB after pruning')
ON CONFLICT DO NOTHING;
EOF

  psql "$CONTROL_DSN" -v SLUG="$SLUG" -v USAGE="$usage_gb" -v CAP="$cap_gb" -f "$sql_file" 2>>"$LOG" || true
  rm -f "$sql_file"
}

# ───────────────────────────────────────────────────────────────────────────────
# Main logic
# ───────────────────────────────────────────────────────────────────────────────
log "=== Disk budget enforcement: slug=${SLUG} warn_at=${WARN_THRESHOLD}% ==="

BACKUP_DIR="/var/backups/agenthive/${SLUG}"
if [[ ! -d "$BACKUP_DIR" ]]; then
  log "  backup dir not found; nothing to enforce"
  exit 0
fi

# Fetch cap from DB
DISK_CAP_GB=$(_get_disk_cap_gb)
DISK_CAP_BYTES=$(( DISK_CAP_GB * 1024 * 1024 * 1024 ))

log "  cap: ${DISK_CAP_GB}GB"

# Current usage
CURRENT_USAGE_BYTES=$(du -sb "$BACKUP_DIR" 2>/dev/null | awk '{print $1}')
CURRENT_USAGE_GB=$(printf "%.2f" "$(echo "scale=2; $CURRENT_USAGE_BYTES / 1024 / 1024 / 1024" | bc)")

log "  current usage: ${CURRENT_USAGE_GB}GB"

# Check warning threshold
WARN_BYTES=$(( DISK_CAP_BYTES * WARN_THRESHOLD / 100 ))
if (( CURRENT_USAGE_BYTES > WARN_BYTES )) && (( CURRENT_USAGE_BYTES <= DISK_CAP_BYTES )); then
  log "  WARNING: usage exceeds ${WARN_THRESHOLD}% threshold; approaching cap"
  _write_event "cap_warning" "Disk usage at ${CURRENT_USAGE_GB}GB (${WARN_THRESHOLD}% of ${DISK_CAP_GB}GB cap)"
fi

# If under cap, all good
if (( CURRENT_USAGE_BYTES <= DISK_CAP_BYTES )); then
  log "  under cap; no pruning needed"
  exit 0
fi

# Over cap: delete oldest .dump files (oldest-first)
log "  OVER CAP by $(( CURRENT_USAGE_BYTES - DISK_CAP_BYTES )) bytes; deleting oldest files..."
_write_event "cap_exceeded" "Disk usage ${CURRENT_USAGE_GB}GB exceeds cap ${DISK_CAP_GB}GB; oldest-first pruning started"

# Find all .dump files (not .manifest, .sha256, .smoke/) sorted by mtime
deleted_bytes=0
while (( CURRENT_USAGE_BYTES > DISK_CAP_BYTES )); do
  oldest=$(find "$BACKUP_DIR" -maxdepth 1 -name "*.dump" -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)

  if [[ -z "$oldest" ]]; then
    log "  no more .dump files to delete; cap still exceeded"
    _escalate_over_cap "$CURRENT_USAGE_GB" "$DISK_CAP_GB"
    exit 1
  fi

  file_size=$(stat -c%s "$oldest" 2>/dev/null || echo 0)
  deleted_bytes=$(( deleted_bytes + file_size ))

  log "  deleting: $(basename "$oldest") ($(( file_size / 1024 / 1024 ))MB)"
  rm -f "$oldest" "${oldest}.sha256" "${oldest}.manifest" 2>>"$LOG" || {
    log "  WARNING: failed to delete $oldest"
  }

  CURRENT_USAGE_BYTES=$(du -sb "$BACKUP_DIR" 2>/dev/null | awk '{print $1}')
  CURRENT_USAGE_GB=$(printf "%.2f" "$(echo "scale=2; $CURRENT_USAGE_BYTES / 1024 / 1024 / 1024" | bc)")
done

log "  pruning complete; freed $(( deleted_bytes / 1024 / 1024 ))MB"
log "  final usage: ${CURRENT_USAGE_GB}GB (under cap)"
_write_event "cap_enforced" "Pruned oldest files; current usage ${CURRENT_USAGE_GB}GB, under cap ${DISK_CAP_GB}GB"

exit 0
