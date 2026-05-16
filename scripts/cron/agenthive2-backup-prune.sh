#!/usr/bin/env bash
# scripts/cron/agenthive2-backup-prune.sh
#
# P895 — Daily backup retention pruning cron.
#
# Runs daily (e.g., 05:00 UTC, after backup-daily.sh). Removes backups past
# retention_until timestamp. Deletes dump files and audit rows.
#
# Required environment:
#   PGHOST, PGUSER, PGPASSWORD (via ~/.pgpass)
#   Docker container name: postgres-db
#
# Exit codes:
#   0 — pruning succeeded
#   1 — critical error

set -euo pipefail

BACKUP_DIR="/var/agenthive/backups"
LOG_DIR="/var/log/agenthive"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_DIR}/backup-prune-${TIMESTAMP}.log"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

log() {
  echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

fail() {
  log "FATAL: $*"
  exit 1
}

log "=== P895 Daily backup pruning starting at $(date -u) ==="

# Check docker container is running
if ! docker ps --filter "name=postgres-db" --filter "status=running" | grep -q postgres-db; then
  fail "postgres-db container not running"
fi

# Query stale backups (retention_until < now)
STALE_BACKUPS=$(docker exec postgres-db psql -d agentHive2 -t -c \
  "SELECT backup_id, storage_uri FROM core.tenant_backup WHERE retention_until < now() ORDER BY taken_at ASC;" | tr -d ' ')

if [ -z "$STALE_BACKUPS" ]; then
  log "No stale backups found; pruning complete"
  exit 0
fi

DELETED_COUNT=0
FAILED_COUNT=0

while IFS= read -r BACKUP_LINE; do
  [ -z "$BACKUP_LINE" ] && continue

  BACKUP_ID=$(echo "$BACKUP_LINE" | awk '{print $1}')
  DUMP_PATH=$(echo "$BACKUP_LINE" | awk '{print $2}')

  log "Pruning backup ${BACKUP_ID}: ${DUMP_PATH}"

  # Delete dump file and related artifacts
  if [ -f "$DUMP_PATH" ]; then
    rm -f "$DUMP_PATH" "$DUMP_PATH.sha256" "$DUMP_PATH.manifest" || {
      log "WARNING: Failed to delete dump file ${DUMP_PATH}"
      FAILED_COUNT=$((FAILED_COUNT + 1))
      continue
    }
    log "Deleted dump file: ${DUMP_PATH}"
  fi

  # Delete audit row
  docker exec postgres-db psql -d agentHive2 -c \
    "DELETE FROM core.tenant_backup WHERE backup_id = '${BACKUP_ID}';" \
    || {
      log "WARNING: Failed to delete audit row for ${BACKUP_ID}"
      FAILED_COUNT=$((FAILED_COUNT + 1))
      continue
    }

  log "Deleted audit record for ${BACKUP_ID}"
  DELETED_COUNT=$((DELETED_COUNT + 1))
done <<< "$STALE_BACKUPS"

# Check for orphaned files (in backup dir but not in audit table)
log "Scanning for orphaned backup files..."
ORPHANED=0
while IFS= read -r DUMP_FILE; do
  if ! docker exec postgres-db psql -d agentHive2 -t -c \
    "SELECT 1 FROM core.tenant_backup WHERE storage_uri = '${DUMP_FILE}';" | grep -q 1; then
    log "WARNING: Orphaned backup file detected (not in audit table): ${DUMP_FILE}"
    ORPHANED=$((ORPHANED + 1))
  fi
done < <(find "$BACKUP_DIR" -type f -name "*.dump" 2>/dev/null || true)

log "=== Backup pruning complete ==="
log "Deleted: ${DELETED_COUNT} backups, ${FAILED_COUNT} failures, ${ORPHANED} orphaned files"

if [ $FAILED_COUNT -gt 0 ]; then
  exit 1
fi
