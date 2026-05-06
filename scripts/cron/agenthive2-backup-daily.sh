#!/usr/bin/env bash
# scripts/cron/agenthive2-backup-daily.sh
#
# P895 — Daily backup cron for agentHive2.
#
# Runs at 04:00 UTC daily. Takes a full DB dump and per-project schema dumps.
# Inserts audit rows into core.tenant_backup with retention policy.
#
# Required environment:
#   PGHOST, PGUSER, PGPASSWORD (via ~/.pgpass)
#   Docker container name: postgres-db
#
# Exit codes:
#   0 — success
#   1 — backup or audit failure

set -euo pipefail

BACKUP_DIR="/var/agenthive/backups"
LOG_DIR="/var/log/agenthive"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_DIR}/backup-daily-${TIMESTAMP}.log"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

log() {
  echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

fail() {
  log "FATAL: $*"
  exit 1
}

log "=== P895 Daily backup starting at $(date -u) ==="

# Check docker container is running
if ! docker ps --filter "name=postgres-db" --filter "status=running" | grep -q postgres-db; then
  fail "postgres-db container not running"
fi

# Full DB backup
FULL_DUMP="${BACKUP_DIR}/agentHive2-full-${TIMESTAMP}.dump"
log "Taking full DB dump to ${FULL_DUMP}..."
docker exec postgres-db pg_dump -F c -d agentHive2 > "$FULL_DUMP" || fail "Full DB dump failed"
SIZE=$(stat -f%z "$FULL_DUMP" 2>/dev/null || stat -c%s "$FULL_DUMP" 2>/dev/null || echo "0")
log "Full dump complete: ${SIZE} bytes"

# Calculate retention_until: 14 days from now
RETENTION_UNTIL=$(date -u -d "+14 days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+14d +%Y-%m-%dT%H:%M:%SZ)

# Record full backup in audit log
BACKUP_ID=$(uuidgen)
docker exec postgres-db psql -d agentHive2 -c \
  "INSERT INTO core.tenant_backup (backup_id, project_id, taken_at, backup_kind, storage_uri, size_bytes, retention_until) VALUES ('${BACKUP_ID}', NULL, now(), 'full', '${FULL_DUMP}', ${SIZE}, '${RETENTION_UNTIL}');" \
  || fail "Failed to record full backup audit row"
log "Full backup audit recorded: ${BACKUP_ID}"

# Per-project schema backups
log "Fetching active projects for schema backups..."
PROJECTS=$(docker exec postgres-db psql -d agentHive2 -t -c "SELECT slug FROM core.project WHERE enabled = true ORDER BY id;" | tr -d ' ')

for PROJECT_SLUG in $PROJECTS; do
  if [ -z "$PROJECT_SLUG" ]; then
    continue
  fi

  SCHEMA_DUMP="${BACKUP_DIR}/agentHive2-schema-${PROJECT_SLUG}-${TIMESTAMP}.dump"
  log "Taking schema dump for project ${PROJECT_SLUG}..."

  docker exec postgres-db pg_dump -n "${PROJECT_SLUG}" -F c --single-transaction -d agentHive2 > "$SCHEMA_DUMP" || {
    log "WARNING: Schema dump for ${PROJECT_SLUG} failed, skipping audit record"
    continue
  }

  SIZE=$(stat -f%z "$SCHEMA_DUMP" 2>/dev/null || stat -c%s "$SCHEMA_DUMP" 2>/dev/null || echo "0")
  log "Schema dump complete for ${PROJECT_SLUG}: ${SIZE} bytes"

  # Record schema backup in audit log (with project_id lookup)
  BACKUP_ID=$(uuidgen)
  docker exec postgres-db psql -d agentHive2 -c \
    "INSERT INTO core.tenant_backup (backup_id, project_id, taken_at, backup_kind, storage_uri, size_bytes, retention_until) SELECT '${BACKUP_ID}', id, now(), 'schema', '${SCHEMA_DUMP}', ${SIZE}, '${RETENTION_UNTIL}' FROM core.project WHERE slug = '${PROJECT_SLUG}';" \
    || {
      log "WARNING: Failed to record schema backup audit row for ${PROJECT_SLUG}"
      continue
    }
  log "Schema backup audit recorded for ${PROJECT_SLUG}: ${BACKUP_ID}"
done

log "=== Daily backup complete at $(date -u) ==="
