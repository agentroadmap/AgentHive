#!/usr/bin/env bash
# deploy/scripts/verify-backup.sh — Restore a backup to a temp DB and verify integrity.
#
# Usage:
#   ./deploy/scripts/verify-backup.sh [options]
#
# Options:
#   -h HOST         Source Postgres host      (default: 127.0.0.1)
#   -p PORT         Source Postgres port      (default: 5432)
#   -U USER         Postgres user             (default: admin)
#   -d DATABASE     Catalog database          (default: agentHive2)
#   -b BACKUP_ID    UUID of core.tenant_backup to verify (required)
#   --dry-run       Print commands, do not execute

set -euo pipefail
cd "$(dirname "$0")/../.."

HOST=127.0.0.1
PORT=5432
USER=admin
DATABASE=agentHive2
BACKUP_ID=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h) HOST="$2";      shift 2 ;;
    -p) PORT="$2";      shift 2 ;;
    -U) USER="$2";      shift 2 ;;
    -d) DATABASE="$2";  shift 2 ;;
    -b) BACKUP_ID="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$BACKUP_ID" ]]; then
  echo "Error: -b BACKUP_ID required"
  exit 1
fi

PSQL="psql -h $HOST -p $PORT -U $USER -d $DATABASE"

# Fetch backup record
ROW=$($PSQL -At -c "
SELECT storage_uri || '|' || COALESCE(schema_name, '') || '|' || backup_kind
FROM core.tenant_backup
WHERE backup_id = '$BACKUP_ID'
LIMIT 1")

if [[ -z "$ROW" ]]; then
  echo "Error: backup_id '$BACKUP_ID' not found in core.tenant_backup"
  exit 1
fi

STORAGE_URI=$(echo "$ROW" | cut -d'|' -f1)
SCHEMA_NAME=$(echo "$ROW" | cut -d'|' -f2)
BACKUP_KIND=$(echo "$ROW" | cut -d'|' -f3)

DUMP_FILE="${STORAGE_URI#file://}"

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Error: dump file not found: $DUMP_FILE"
  # Emit governance event for missing file
  $PSQL -c "
INSERT INTO governance.event (event_type, actor_did, subject_ref, payload_jsonb)
VALUES ('backup_verify_failed', 'system', 'backup:$BACKUP_ID',
  jsonb_build_object('reason','dump_file_not_found','storage_uri','$STORAGE_URI'));" 2>/dev/null || true
  $PSQL -c "UPDATE core.tenant_backup SET verify_status='failed', verified_at=now() WHERE backup_id='$BACKUP_ID';" 2>/dev/null || true
  exit 1
fi

TEMP_DB="agenthive_verify_$(date -u +%s)"
echo "==> verify $BACKUP_KIND backup $BACKUP_ID → temp DB $TEMP_DB"

if $DRY_RUN; then
  echo "[dry-run] createdb $TEMP_DB && pg_restore -d $TEMP_DB $DUMP_FILE && dropdb $TEMP_DB"
  exit 0
fi

VERIFY_STATUS="ok"
VERIFY_REASON=""

cleanup() {
  psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$TEMP_DB\";" 2>/dev/null || true
}
trap cleanup EXIT

psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres -c "CREATE DATABASE \"$TEMP_DB\";" || {
  VERIFY_STATUS="failed"
  VERIFY_REASON="createdb_failed"
}

if [[ "$VERIFY_STATUS" == "ok" ]]; then
  pg_restore -h "$HOST" -p "$PORT" -U "$USER" -d "$TEMP_DB" \
    --no-owner --no-privileges --exit-on-error "$DUMP_FILE" || {
    VERIFY_STATUS="failed"
    VERIFY_REASON="pg_restore_failed"
  }
fi

# Smoke-test: confirm at least one table exists in restored DB
if [[ "$VERIFY_STATUS" == "ok" ]]; then
  TABLE_COUNT=$(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$TEMP_DB" -At \
    -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_type='BASE TABLE'")
  if [[ "${TABLE_COUNT:-0}" -eq 0 ]]; then
    VERIFY_STATUS="failed"
    VERIFY_REASON="no_tables_restored"
  fi
fi

# Update manifest
$PSQL -c "
UPDATE core.tenant_backup
SET verify_status='$VERIFY_STATUS', verified_at=now()
WHERE backup_id='$BACKUP_ID';"

if [[ "$VERIFY_STATUS" == "failed" ]]; then
  echo "==> verification FAILED: $VERIFY_REASON"
  $PSQL -c "
INSERT INTO governance.event (event_type, actor_did, subject_ref, payload_jsonb)
VALUES ('backup_verify_failed', 'system', 'backup:$BACKUP_ID',
  jsonb_build_object('reason','$VERIFY_REASON','backup_id','$BACKUP_ID','storage_uri','$STORAGE_URI'));" 2>/dev/null || true
  exit 1
fi

echo "==> verification OK (backup_id=$BACKUP_ID)"
