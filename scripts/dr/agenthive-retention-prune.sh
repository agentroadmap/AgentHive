#!/usr/bin/env bash
# scripts/dr/agenthive-retention-prune.sh
#
# P509: Per-tenant backup retention pruning and disk-cap enforcement.
#
# Usage: agenthive-retention-prune.sh <slug>
#
# Required env:
#   PGHOST          — control-plane DB host (default: 127.0.0.1)
#   PGPORT          — control-plane DB port (default: 5432)
#   PGUSER          — control-plane DB user (default: admin)
#   PGDATABASE      — control-plane DB name (default: agenthive)
#   BACKUP_ROOT     — parent directory for backup storage (default: /var/backups/agenthive)
#   NODE_EXPORTER_TEXTFILE_DIR — Prometheus textfile collector dir
#                                (default: /var/lib/node_exporter/textfile_collector)
#   AGENT_IDENTITY  — identity logged to escalation_log (default: cron/agenthive-retention-prune)
#
# Behavior:
#   1. Reads per-tenant policy from roadmap.tenant_backup_policy.
#   2. Prunes backups using daily/weekly/monthly retention buckets.
#   3. Enforces the hard disk cap by pruning oldest remaining dumps first.
#   4. Emits Prometheus textfile metrics.
#   5. Logs unresolved disk-cap overflow to roadmap.escalation_log.

set -euo pipefail

SLUG="${1:?Usage: $0 <slug>}"

CTL_HOST="${PGHOST:-127.0.0.1}"
CTL_PORT="${PGPORT:-5432}"
CTL_USER="${PGUSER:-admin}"
CTL_DB="${PGDATABASE:-agenthive}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/agenthive}"
METRICS_DIR="${NODE_EXPORTER_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
AGENT_IDENTITY="${AGENT_IDENTITY:-cron/agenthive-retention-prune}"

BACKUP_DIR="$BACKUP_ROOT/$SLUG"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
LOG_DIR="/home/xiaomi/.hermes/cron/output"
LOG="$LOG_DIR/retention-prune-${SLUG}-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

log()  { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FATAL: $*"; exit "${2:-1}"; }

PSQL_CTL="psql -h $CTL_HOST -p $CTL_PORT -U $CTL_USER -d $CTL_DB"

PROJECT_ID=""
DISK_CAP_GB=50
RETAIN_DAILY_DAYS=14
RETAIN_WEEKLY_COUNT=8
RETAIN_MONTHLY_COUNT=12
USAGE_BYTES=0
CAP_EXCEEDED=0
CAP_EXCEEDED_TOTAL=0
FILES_RETAINED=0
FILES_DELETED=0
DAILY_CUTOFF=""

read_policy() {
  local row
  row=$($PSQL_CTL -F $'\t' -Atc "
    SELECT p.project_id,
           COALESCE(pol.disk_cap_gb, 50),
           COALESCE(pol.retain_daily_days, 14),
           COALESCE(pol.retain_weekly_count, 8),
           COALESCE(pol.retain_monthly_count, 12)
      FROM roadmap.project p
      LEFT JOIN roadmap.tenant_backup_policy pol
        ON pol.project_id = p.project_id
     WHERE p.slug = '$SLUG'
       AND p.status = 'active'
     LIMIT 1
  ") || fail "Control-plane policy lookup failed" 1

  [[ -z "$row" ]] && fail "No active project with slug='$SLUG'" 1
  IFS=$'\t' read -r PROJECT_ID DISK_CAP_GB RETAIN_DAILY_DAYS RETAIN_WEEKLY_COUNT RETAIN_MONTHLY_COUNT <<< "$row"
  DAILY_CUTOFF="$(date -u -d "${RETAIN_DAILY_DAYS} days ago" +%s)"
}

current_usage_bytes() {
  if [[ -d "$BACKUP_DIR" ]]; then
    du -sb "$BACKUP_DIR" | awk '{print $1}'
  else
    echo 0
  fi
}

remove_backup_artifacts() {
  local dump_file="$1"
  rm -f "$dump_file" "$dump_file.sha256" "$dump_file.manifest"
}

delete_catalog_row() {
  local storage_uri="$1"
  $PSQL_CTL -v ON_ERROR_STOP=1 -c "
    DELETE FROM roadmap.tenant_backup
     WHERE project_id = $PROJECT_ID
       AND storage_uri = '$storage_uri'
  " >>"$LOG" 2>&1 || log "  WARNING: failed to delete catalog row for $storage_uri"
}

record_escalation() {
  local note="$1"
  $PSQL_CTL -v ON_ERROR_STOP=1 -c "
    INSERT INTO roadmap.escalation_log
      (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
    VALUES
      ('PIPELINE_BLOCKED', 'P509', '$AGENT_IDENTITY', 'ops', 'high', '$note')
  " >>"$LOG" 2>&1 || log "  WARNING: failed to write escalation_log"
}

load_cap_counter() {
  local state_file
  state_file="${METRICS_DIR}/state/backup-disk-cap-${SLUG}.count"
  if [[ -f "$state_file" ]]; then
    CAP_EXCEEDED_TOTAL="$(cat "$state_file" 2>/dev/null || echo 0)"
  else
    CAP_EXCEEDED_TOTAL=0
  fi
}

increment_cap_counter() {
  local state_dir state_file current
  state_dir="${METRICS_DIR}/state"
  state_file="${state_dir}/backup-disk-cap-${SLUG}.count"
  mkdir -p "$state_dir"
  current=0
  if [[ -f "$state_file" ]]; then
    current="$(cat "$state_file" 2>/dev/null || echo 0)"
  fi
  current=$((current + 1))
  printf '%s\n' "$current" > "$state_file"
  CAP_EXCEEDED_TOTAL="$current"
}

write_metrics() {
  local metric_file tmp_file
  metric_file="$METRICS_DIR/agenthive-tenant-backup-retention-${SLUG}.prom"
  tmp_file="${metric_file}.tmp"

  mkdir -p "$METRICS_DIR"

  cat > "$tmp_file" <<METRICS
# HELP agenthive_tenant_backup_disk_usage_bytes Current bytes consumed by tenant backup artifacts.
# TYPE agenthive_tenant_backup_disk_usage_bytes gauge
agenthive_tenant_backup_disk_usage_bytes{slug="$SLUG"} $USAGE_BYTES
# HELP agenthive_tenant_backup_disk_cap_bytes Configured hard disk cap for tenant backup artifacts.
# TYPE agenthive_tenant_backup_disk_cap_bytes gauge
agenthive_tenant_backup_disk_cap_bytes{slug="$SLUG"} $((DISK_CAP_GB * 1024 * 1024 * 1024))
# HELP agenthive_backup_disk_cap_exceeded Whether the tenant is currently above the configured backup disk cap.
# TYPE agenthive_backup_disk_cap_exceeded gauge
agenthive_backup_disk_cap_exceeded{slug="$SLUG"} $CAP_EXCEEDED
# HELP agenthive_backup_disk_cap_exceeded_total Total cap-exceeded incidents observed by the prune job.
# TYPE agenthive_backup_disk_cap_exceeded_total counter
agenthive_backup_disk_cap_exceeded_total{slug="$SLUG"} $CAP_EXCEEDED_TOTAL
# HELP agenthive_tenant_backup_files_retained Count of dump files retained after pruning.
# TYPE agenthive_tenant_backup_files_retained gauge
agenthive_tenant_backup_files_retained{slug="$SLUG"} $FILES_RETAINED
# HELP agenthive_tenant_backup_files_deleted_total Dump files deleted during the current prune invocation.
# TYPE agenthive_tenant_backup_files_deleted_total gauge
agenthive_tenant_backup_files_deleted_total{slug="$SLUG"} $FILES_DELETED
METRICS

  mv "$tmp_file" "$metric_file"
}

gather_backups() {
  $PSQL_CTL -F $'\t' -Atc "
    SELECT backup_id,
           EXTRACT(EPOCH FROM taken_at)::bigint,
           to_char(taken_at AT TIME ZONE 'UTC', 'IYYY-IW'),
           to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM'),
           storage_uri
      FROM roadmap.tenant_backup
     WHERE project_id = $PROJECT_ID
       AND backup_kind = 'logical'
       AND storage_uri LIKE 'file://%'
     ORDER BY taken_at DESC
  "
}

should_keep_backup() {
  local taken_epoch="$1"
  local week_key="$2"
  local month_key="$3"

  if (( taken_epoch >= DAILY_CUTOFF )); then
    return 0
  fi

  if [[ -z "${SEEN_WEEKLY[$week_key]:-}" && $WEEKLY_COUNT -lt $RETAIN_WEEKLY_COUNT ]]; then
    SEEN_WEEKLY[$week_key]=1
    WEEKLY_COUNT=$((WEEKLY_COUNT + 1))
    return 0
  fi

  if [[ -z "${SEEN_MONTHLY[$month_key]:-}" && $MONTHLY_COUNT -lt $RETAIN_MONTHLY_COUNT ]]; then
    SEEN_MONTHLY[$month_key]=1
    MONTHLY_COUNT=$((MONTHLY_COUNT + 1))
    return 0
  fi

  return 1
}

prune_retention() {
  local backup_id taken_epoch week_key month_key storage_uri dump_file
  declare -gA SEEN_WEEKLY=()
  declare -gA SEEN_MONTHLY=()
  declare -g WEEKLY_COUNT=0
  declare -g MONTHLY_COUNT=0

  while IFS=$'\t' read -r backup_id taken_epoch week_key month_key storage_uri; do
    [[ -z "$backup_id" ]] && continue
    dump_file="${storage_uri#file://}"

    if [[ ! -f "$dump_file" ]]; then
      log "  Missing file for catalog row $backup_id ($storage_uri); pruning catalog row"
      delete_catalog_row "$storage_uri"
      continue
    fi

    if should_keep_backup "$taken_epoch" "$week_key" "$month_key"; then
      FILES_RETAINED=$((FILES_RETAINED + 1))
      continue
    fi

    log "  Retention prune delete: $dump_file"
    remove_backup_artifacts "$dump_file"
    delete_catalog_row "$storage_uri"
    FILES_DELETED=$((FILES_DELETED + 1))
  done < <(gather_backups)
}

enforce_disk_cap() {
  local disk_cap_bytes oldest_uri oldest_file oldest_size overflow_note
  disk_cap_bytes=$((DISK_CAP_GB * 1024 * 1024 * 1024))
  USAGE_BYTES="$(current_usage_bytes)"

  if (( USAGE_BYTES <= disk_cap_bytes )); then
    CAP_EXCEEDED=0
    return
  fi

  CAP_EXCEEDED=1
  increment_cap_counter
  log "  WARNING: disk cap exceeded for $SLUG ($USAGE_BYTES bytes > $disk_cap_bytes bytes)"

  while (( USAGE_BYTES > disk_cap_bytes )); do
    oldest_uri=$($PSQL_CTL -Atc "
      SELECT storage_uri
        FROM roadmap.tenant_backup
       WHERE project_id = $PROJECT_ID
         AND backup_kind = 'logical'
         AND storage_uri LIKE 'file://%'
       ORDER BY taken_at ASC
       LIMIT 1
    ")

    [[ -z "$oldest_uri" ]] && break
    oldest_file="${oldest_uri#file://}"

    if [[ ! -f "$oldest_file" ]]; then
      delete_catalog_row "$oldest_uri"
      continue
    fi

    oldest_size="$(stat -c%s "$oldest_file")"
    log "  Cap prune delete: $oldest_file"
    remove_backup_artifacts "$oldest_file"
    delete_catalog_row "$oldest_uri"
    FILES_DELETED=$((FILES_DELETED + 1))
    if (( FILES_RETAINED > 0 )); then
      FILES_RETAINED=$((FILES_RETAINED - 1))
    fi
    USAGE_BYTES=$((USAGE_BYTES - oldest_size))
  done

  USAGE_BYTES="$(current_usage_bytes)"
  if (( USAGE_BYTES > disk_cap_bytes )); then
    overflow_note="tenant backup disk cap still exceeded for slug=$SLUG after prune; usage_bytes=$USAGE_BYTES cap_bytes=$disk_cap_bytes log=$LOG"
    record_escalation "$overflow_note"
    fail "Disk cap still exceeded after aggressive prune" 1
  fi

  CAP_EXCEEDED=0
}

log "=== Retention prune starting: slug=$SLUG ts=$TIMESTAMP ==="
read_policy
load_cap_counter

if [[ ! -d "$BACKUP_DIR" ]]; then
  log "Backup dir missing ($BACKUP_DIR); nothing to prune"
  write_metrics
  exit 0
fi

log "Policy: disk_cap_gb=$DISK_CAP_GB daily=$RETAIN_DAILY_DAYS weekly=$RETAIN_WEEKLY_COUNT monthly=$RETAIN_MONTHLY_COUNT"
prune_retention
enforce_disk_cap
USAGE_BYTES="$(current_usage_bytes)"
write_metrics

log "=== Retention prune complete: retained=$FILES_RETAINED deleted=$FILES_DELETED usage_bytes=$USAGE_BYTES ==="
