#!/usr/bin/env bash
# deploy/scripts/backup.sh — Take a pg_dump backup for one or all projects.
#
# Usage:
#   ./deploy/scripts/backup.sh [options]
#
# Options:
#   -h HOST        Postgres host          (default: 127.0.0.1)
#   -p PORT        Postgres port          (default: 5432)
#   -U USER        Postgres user          (default: admin)
#   -d DATABASE    Target database        (default: agentHive2)
#   -s SCHEMA      Project schema (omit for full-DB backup)
#   -o OUTPUT_DIR  Override output dir    (default: from policy or /var/backups/agenthive)
#   --dry-run      Print commands, do not execute
#
# The script inserts a row into core.tenant_backup after each successful dump.
# Retention window is read from core.tenant_backup_policy when available.

set -euo pipefail
cd "$(dirname "$0")/../.."

HOST=127.0.0.1
PORT=5432
USER=admin
DATABASE=agentHive2
SCHEMA=""
OUTPUT_DIR=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h) HOST="$2";       shift 2 ;;
    -p) PORT="$2";       shift 2 ;;
    -U) USER="$2";       shift 2 ;;
    -d) DATABASE="$2";   shift 2 ;;
    -s) SCHEMA="$2";     shift 2 ;;
    -o) OUTPUT_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PSQL="psql -h $HOST -p $PORT -U $USER -d $DATABASE"
PG_DUMP="pg_dump -h $HOST -p $PORT -U $USER -d $DATABASE"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

# Determine retention days (default 30) and output prefix from policy
if [[ -n "$SCHEMA" ]]; then
  POLICY=$($PSQL -At -c "
    SELECT COALESCE(p.retention_days, 30)::text || '|' ||
           COALESCE(p.target_uri_prefix, 'file:///var/backups/agenthive')
    FROM core.tenant_backup_policy p
    JOIN core.project proj ON p.project_id = proj.id
    WHERE proj.schema_name = '$SCHEMA'
    LIMIT 1" 2>/dev/null || echo "30|file:///var/backups/agenthive")
else
  POLICY=$($PSQL -At -c "
    SELECT '30|file:///var/backups/agenthive'" 2>/dev/null || echo "30|file:///var/backups/agenthive")
fi

RETENTION_DAYS=$(echo "$POLICY" | cut -d'|' -f1)
POLICY_PREFIX=$(echo "$POLICY" | cut -d'|' -f2 | sed 's|^file://||')

if [[ -n "$OUTPUT_DIR" ]]; then
  BASE_DIR="$OUTPUT_DIR"
else
  BASE_DIR="$POLICY_PREFIX"
fi

mkdir -p "$BASE_DIR"

if [[ -n "$SCHEMA" ]]; then
  BACKUP_KIND="schema"
  FILENAME="${DATABASE}_${SCHEMA}_${TIMESTAMP}.dump"
  DUMP_ARGS="-n $SCHEMA -Fc"
else
  BACKUP_KIND="full"
  FILENAME="${DATABASE}_full_${TIMESTAMP}.dump"
  DUMP_ARGS="-Fc"
fi

OUT_PATH="$BASE_DIR/$FILENAME"
STORAGE_URI="file://$OUT_PATH"
RETENTION_UNTIL=$(date -u -d "+${RETENTION_DAYS} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || date -u -v "+${RETENTION_DAYS}d" +"%Y-%m-%dT%H:%M:%SZ")  # macOS fallback

echo "==> backup: $BACKUP_KIND → $OUT_PATH (retain until $RETENTION_UNTIL)"

if $DRY_RUN; then
  echo "[dry-run] $PG_DUMP $DUMP_ARGS -f $OUT_PATH"
  exit 0
fi

$PG_DUMP $DUMP_ARGS -f "$OUT_PATH"
SIZE=$(stat -c%s "$OUT_PATH" 2>/dev/null || stat -f%z "$OUT_PATH")
PG_VER=$($PSQL -At -c "SELECT version()" 2>/dev/null | head -1 || echo "unknown")

# Record in manifest
PROJECT_ID_EXPR="(SELECT id FROM core.project WHERE schema_name = '$SCHEMA' LIMIT 1)"
if [[ -z "$SCHEMA" ]]; then
  PROJECT_ID_EXPR="NULL"
fi

$PSQL -c "
INSERT INTO core.tenant_backup
  (project_id, backup_kind, storage_uri, size_bytes, schema_name, pg_version, dump_format, retention_until)
VALUES (
  $PROJECT_ID_EXPR,
  '$BACKUP_KIND',
  '$STORAGE_URI',
  $SIZE,
  $([ -n "$SCHEMA" ] && echo "'$SCHEMA'" || echo "NULL"),
  $([ -n "$PG_VER" ] && echo "'${PG_VER//\'/\'\'}'" || echo "NULL"),
  'custom',
  '$RETENTION_UNTIL'
);"

echo "==> backup recorded: $STORAGE_URI ($SIZE bytes)"
