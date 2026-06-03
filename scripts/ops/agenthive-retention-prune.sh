#!/usr/bin/env bash
# scripts/ops/agenthive-retention-prune.sh
#
# P509 — Daily retention pruning with disk budget enforcement.
#
# Usage:
#   agenthive-retention-prune.sh <slug> [--dry-run]
#
# Config (first match wins):
#   /etc/agenthive/backup-policy.conf  — INI-style: DISK_CAP_GB_<SLUG>=50
#   AGENTHIVE_BACKUP_DISK_CAP_GB       — env override (applies to all slugs)
#   Default: 50 GB per tenant
#
# Retention policy (configurable via env or config):
#   RETENTION_DAILY_DAYS   — daily dumps to keep (default: 14)
#   RETENTION_WEEKLY_COUNT — weekly dumps to keep (default: 8)
#   RETENTION_MONTHLY_COUNT— monthly dumps to keep (default: 12)
#
# Prometheus metric:
#   Writes agenthive_backup_disk_cap_exceeded_total{slug=<slug>} to
#   /var/lib/node_exporter/textfile/<slug>-backup.prom (node_exporter textfile collector)
#
# Exit codes:
#   0 — pruning complete (may have deleted files)
#   1 — disk cap still exceeded after pruning (ops alert)
#   3 — bad arguments

set -euo pipefail

SLUG="${1:?Usage: $0 <slug> [--dry-run]}"
DRY_RUN=false
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

LOG_DIR="/var/log/agenthive"
PROM_DIR="/var/lib/node_exporter/textfile"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/retention-${SLUG}.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }
$DRY_RUN && log "(DRY RUN — no files will be deleted)"

# ── Config loading ─────────────────────────────────────────────────────────────
POLICY_FILE="/etc/agenthive/backup-policy.conf"
SLUG_UPPER="${SLUG//-/_}"
SLUG_UPPER="${SLUG_UPPER^^}"

_conf_get() {
  local key="$1" default="$2"
  local val="${!key:-}"
  if [[ -z "$val" && -f "$POLICY_FILE" ]]; then
    val=$(grep -E "^${key}=" "$POLICY_FILE" 2>/dev/null | cut -d= -f2- || true)
  fi
  echo "${val:-$default}"
}

DISK_CAP_GB=$(_conf_get "DISK_CAP_GB_${SLUG_UPPER}" \
              "$(_conf_get AGENTHIVE_BACKUP_DISK_CAP_GB 50)")
RETENTION_DAILY_DAYS=$(_conf_get RETENTION_DAILY_DAYS 14)
RETENTION_WEEKLY_COUNT=$(_conf_get RETENTION_WEEKLY_COUNT 8)
RETENTION_MONTHLY_COUNT=$(_conf_get RETENTION_MONTHLY_COUNT 12)

DISK_CAP_BYTES=$(( DISK_CAP_GB * 1024 * 1024 * 1024 ))
BACKUP_DIR="/var/backups/agenthive/${SLUG}"

log "=== Retention prune: slug=${SLUG} cap=${DISK_CAP_GB}GB ==="
log "  policy: daily=${RETENTION_DAILY_DAYS}d weekly=${RETENTION_WEEKLY_COUNT} monthly=${RETENTION_MONTHLY_COUNT}"

[ -d "$BACKUP_DIR" ] || { log "  backup dir ${BACKUP_DIR} not found; nothing to prune"; exit 0; }

# ── Current disk usage ────────────────────────────────────────────────────────
_usage_bytes() {
  du -sb "$BACKUP_DIR" 2>/dev/null | awk '{print $1}'
}

_emit_prom() {
  local exceeded="${1:-0}"
  mkdir -p "$PROM_DIR" 2>/dev/null || return 0
  local prom_file="${PROM_DIR}/${SLUG}-backup.prom"
  {
    echo "# HELP agenthive_backup_disk_cap_exceeded_total Times backup disk cap was exceeded for this tenant"
    echo "# TYPE agenthive_backup_disk_cap_exceeded_total counter"
    echo "agenthive_backup_disk_cap_exceeded_total{slug=\"${SLUG}\"} ${exceeded}"
    echo "# HELP agenthive_backup_disk_usage_bytes Current backup directory size in bytes"
    echo "# TYPE agenthive_backup_disk_usage_bytes gauge"
    echo "agenthive_backup_disk_usage_bytes{slug=\"${SLUG}\",cap_gb=\"${DISK_CAP_GB}\"} ${USAGE_BYTES}"
    echo "# HELP agenthive_backup_disk_cap_gb Configured backup disk cap in gigabytes"
    echo "# TYPE agenthive_backup_disk_cap_gb gauge"
    echo "agenthive_backup_disk_cap_gb{slug=\"${SLUG}\",cap_gb=\"${DISK_CAP_GB}\"} ${DISK_CAP_GB}"
  } > "$prom_file"
}

USAGE_BYTES=$(_usage_bytes)
USAGE_GB=$(( USAGE_BYTES / 1024 / 1024 / 1024 ))
log "  disk usage: ${USAGE_GB} GB / ${DISK_CAP_GB} GB cap"

# ── Phase 1: Emergency prune if over cap ───────────────────────────────────────
# NOTE: We use a file-by-file loop with re-read of USAGE_BYTES (not subshell)
# to correctly track freed space after each deletion.
if [[ "$USAGE_BYTES" -gt "$DISK_CAP_BYTES" ]]; then
  log "  WARNING: disk cap EXCEEDED — purging oldest dumps first"

  # Build sorted list to a temp file (oldest first) to avoid subshell variable scope
  TMPLIST=$(mktemp)
  ls -tr "${BACKUP_DIR}"/*.dump 2>/dev/null | grep -v '\.smoke/' > "$TMPLIST" || true

  while IFS= read -r DUMP; do
    USAGE_BYTES=$(_usage_bytes)
    [[ "$USAGE_BYTES" -le "$DISK_CAP_BYTES" ]] && break
    DUMP_SIZE=$(stat -c%s "$DUMP" 2>/dev/null || echo 0)
    if $DRY_RUN; then
      log "  DRY RUN: would delete ${DUMP} ($(( DUMP_SIZE / 1024 / 1024 )) MB)"
    else
      rm -f "$DUMP" "${DUMP}.sha256" "${DUMP}.manifest" 2>/dev/null || true
      log "  deleted ${DUMP} ($(( DUMP_SIZE / 1024 / 1024 )) MB freed)"
    fi
  done < "$TMPLIST"
  rm -f "$TMPLIST"

  USAGE_BYTES=$(_usage_bytes)
  USAGE_GB=$(( USAGE_BYTES / 1024 / 1024 / 1024 ))

  if [[ "$USAGE_BYTES" -gt "$DISK_CAP_BYTES" ]]; then
    log "  ALERT: cap still exceeded after purge (${USAGE_GB} GB used)"
    _emit_prom 1
    exit 1
  fi
fi

# ── Phase 2: Standard retention policy pruning ────────────────────────────────
# Strategy:
#   - DAILY bucket: keep last RETENTION_DAILY_DAYS calendar days (one dump per day = latest)
#   - WEEKLY bucket: for days outside DAILY window, keep one dump per week x RETENTION_WEEKLY_COUNT
#   - MONTHLY bucket: for days outside WEEKLY window, keep one dump per month x RETENTION_MONTHLY_COUNT
#   - Everything else: delete
#
# Implementation: tag each dump by day/week/month, keep best-of-bucket, delete the rest.

NOW_EPOCH=$(date +%s)
DAILY_CUTOFF_EPOCH=$(( NOW_EPOCH - RETENTION_DAILY_DAYS * 86400 ))
WEEKLY_CUTOFF_EPOCH=$(( NOW_EPOCH - RETENTION_WEEKLY_COUNT * 7 * 86400 ))
MONTHLY_CUTOFF_EPOCH=$(( NOW_EPOCH - RETENTION_MONTHLY_COUNT * 30 * 86400 ))

declare -A KEEP_DAILY KEEP_WEEKLY KEEP_MONTHLY

# Collect all dumps newest-first and build keep sets
while IFS= read -r DUMP; do
  FNAME=$(basename "$DUMP")
  # Filename format: YYYYMMDD-HHMMSS.dump
  DATE_PART="${FNAME:0:8}"
  if [[ ! "$DATE_PART" =~ ^[0-9]{8}$ ]]; then
    continue
  fi
  DUMP_EPOCH=$(date -d "${DATE_PART}" +%s 2>/dev/null || echo 0)

  if [[ "$DUMP_EPOCH" -ge "$DAILY_CUTOFF_EPOCH" ]]; then
    DAY_KEY="${DATE_PART}"
    [[ -z "${KEEP_DAILY[$DAY_KEY]:-}" ]] && KEEP_DAILY[$DAY_KEY]="$DUMP"
  elif [[ "$DUMP_EPOCH" -ge "$WEEKLY_CUTOFF_EPOCH" ]]; then
    WEEK_KEY=$(date -d "${DATE_PART}" +%Y-W%V 2>/dev/null || echo "unknown")
    [[ -z "${KEEP_WEEKLY[$WEEK_KEY]:-}" ]] && KEEP_WEEKLY[$WEEK_KEY]="$DUMP"
  elif [[ "$DUMP_EPOCH" -ge "$MONTHLY_CUTOFF_EPOCH" ]]; then
    MONTH_KEY=$(date -d "${DATE_PART}" +%Y-%m 2>/dev/null || echo "unknown")
    [[ -z "${KEEP_MONTHLY[$MONTH_KEY]:-}" ]] && KEEP_MONTHLY[$MONTH_KEY]="$DUMP"
  fi
  # Older than monthly cutoff: not added to any keep set → eligible for deletion
done < <(ls -tr "${BACKUP_DIR}"/*.dump 2>/dev/null | grep -v '\.smoke/' || true)

# Build a set of files to keep
declare -A KEEP_SET
for v in "${KEEP_DAILY[@]:-}"; do [[ -n "$v" ]] && KEEP_SET["$v"]=1; done
for v in "${KEEP_WEEKLY[@]:-}"; do [[ -n "$v" ]] && KEEP_SET["$v"]=1; done
for v in "${KEEP_MONTHLY[@]:-}"; do [[ -n "$v" ]] && KEEP_SET["$v"]=1; done

DELETED=0
while IFS= read -r DUMP; do
  [[ -n "${KEEP_SET[$DUMP]:-}" ]] && continue
  if $DRY_RUN; then
    log "  DRY RUN: would prune ${DUMP}"
  else
    rm -f "$DUMP" "${DUMP}.sha256" "${DUMP}.manifest" 2>/dev/null || true
    log "  pruned: ${DUMP}"
    DELETED=$(( DELETED + 1 ))
  fi
done < <(ls -tr "${BACKUP_DIR}"/*.dump 2>/dev/null | grep -v '\.smoke/' || true)

USAGE_BYTES=$(_usage_bytes)
log "  retention pruning complete — deleted ${DELETED} dumps; final usage: $(( USAGE_BYTES / 1024 / 1024 )) MB"

_emit_prom 0
exit 0
