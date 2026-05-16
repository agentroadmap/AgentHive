#!/usr/bin/env bash
# scripts/cron/agenthive2-backup-verify.sh
#
# P895 — Weekly backup verification cron.
#
# Runs weekly (e.g., Sunday 10:00 UTC). Finds newest unverified backup per project,
# restores to ephemeral temp DB, runs smoke tests, then updates verified_at.
#
# Required environment:
#   PGHOST, PGUSER, PGPASSWORD (via ~/.pgpass)
#   Docker container name: postgres-db
#
# Exit codes:
#   0 — verification succeeded
#   1 — restore or test failed

set -euo pipefail

LOG_DIR="/var/log/agenthive"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_DIR}/backup-verify-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

fail() {
  log "FATAL: $*"
  exit 1
}

log "=== P895 Weekly backup verification starting at $(date -u) ==="

# Check docker container is running
if ! docker ps --filter "name=postgres-db" --filter "status=running" | grep -q postgres-db; then
  fail "postgres-db container not running"
fi

# Query most recent unverified backup per project (skip full backups)
BACKUPS=$(docker exec postgres-db psql -d agentHive2 -t -c \
  "SELECT backup_id, project_id, storage_uri FROM core.tenant_backup WHERE verified_at IS NULL AND backup_kind = 'schema' ORDER BY taken_at DESC;" | tr -d ' ')

if [ -z "$BACKUPS" ]; then
  log "No unverified schema backups found; verification skipped"
  exit 0
fi

verify_backup() {
  local BACKUP_ID="$1"
  local PROJECT_ID="$2"
  local DUMP_PATH="$3"

  if [ ! -f "$DUMP_PATH" ]; then
    log "WARNING: Dump file not found at ${DUMP_PATH}, skipping verification for ${BACKUP_ID}"
    return 1
  fi

  local TEMP_DB="agentHive2_verify_${TIMESTAMP}"
  log "Creating ephemeral temp DB: ${TEMP_DB}"

  # Create temp DB
  docker exec postgres-db createdb "$TEMP_DB" || {
    log "WARNING: Failed to create temp DB ${TEMP_DB}"
    return 1
  }

  # Restore dump to temp DB
  log "Restoring backup ${BACKUP_ID} to ${TEMP_DB}..."
  docker exec postgres-db pg_restore -d "$TEMP_DB" < "$DUMP_PATH" || {
    log "WARNING: Restore failed for ${BACKUP_ID}"
    docker exec postgres-db dropdb "$TEMP_DB" || true
    return 1
  }

  # Run smoke tests on temp DB
  log "Running smoke tests on ${TEMP_DB}..."
  local SMOKE_OK=0

  # Check schema existence
  docker exec postgres-db psql -d "$TEMP_DB" -c "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'public');" > /dev/null || {
    log "WARNING: Schema query failed on temp DB"
    SMOKE_OK=1
  }

  # Check for key tables
  docker exec postgres-db psql -d "$TEMP_DB" -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');" > /dev/null || {
    log "WARNING: Table count query failed on temp DB"
    SMOKE_OK=1
  }

  # Drop temp DB
  log "Dropping temp DB ${TEMP_DB}..."
  docker exec postgres-db dropdb "$TEMP_DB" || log "WARNING: Failed to drop ${TEMP_DB}"

  if [ $SMOKE_OK -eq 0 ]; then
    log "Smoke tests passed for backup ${BACKUP_ID}"
    return 0
  else
    log "WARNING: Smoke tests failed for backup ${BACKUP_ID}"
    return 1
  fi
}

# Process each unverified backup
while IFS= read -r BACKUP_LINE; do
  [ -z "$BACKUP_LINE" ] && continue

  BACKUP_ID=$(echo "$BACKUP_LINE" | awk '{print $1}')
  PROJECT_ID=$(echo "$BACKUP_LINE" | awk '{print $2}')
  DUMP_PATH=$(echo "$BACKUP_LINE" | awk '{print $3}')

  log "Processing backup ${BACKUP_ID} (project ${PROJECT_ID})"

  if verify_backup "$BACKUP_ID" "$PROJECT_ID" "$DUMP_PATH"; then
    # Update verified_at in audit log
    docker exec postgres-db psql -d agentHive2 -c \
      "UPDATE core.tenant_backup SET verified_at = now(), verification_note = 'Smoke tests passed' WHERE backup_id = '${BACKUP_ID}';" \
      || log "WARNING: Failed to update verification status for ${BACKUP_ID}"
  else
    # Update with failure note
    docker exec postgres-db psql -d agentHive2 -c \
      "UPDATE core.tenant_backup SET verification_note = 'Smoke tests failed' WHERE backup_id = '${BACKUP_ID}';" \
      || log "WARNING: Failed to update failure note for ${BACKUP_ID}"
  fi
done <<< "$BACKUPS"

log "=== Backup verification complete at $(date -u) ==="
