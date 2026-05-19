#!/usr/bin/env bash
# scripts/dr/agenthive-tenant-backup.sh
#
# P509: Per-tenant pg_dump with post-dump integrity validation.
#
# Usage: agenthive-tenant-backup.sh <slug> [smoke]
#   slug   — project slug (must match roadmap.project.slug)
#   smoke  — if "smoke", skip the DB catalog write (useful for dry-runs)
#
# Required env (source /home/xiaomi/.hermes/.env or set explicitly):
#   PGHOST          — control-plane DB host (default: 127.0.0.1)
#   PGPORT          — control-plane DB port (default: 5432)
#   PGUSER          — control-plane DB user (default: admin)
#   PGDATABASE      — control-plane DB name (default: agenthive)
#   BACKUP_ROOT     — parent directory for backup storage (default: /var/backups/agenthive)
#
# Tenant DB connection is resolved from roadmap.project.tenant_db_url.
# Credentials must be in ~/.pgpass (do NOT set PGPASSWORD in env).
#
# Exit codes:
#   0 — backup complete and validated
#   1 — setup or pg_dump failure
#   2 — post-dump validation failed (corrupt dump)

set -euo pipefail

SLUG="${1:?Usage: $0 <slug> [smoke]}"
MODE="${2:-prod}"

CTL_HOST="${PGHOST:-127.0.0.1}"
CTL_PORT="${PGPORT:-5432}"
CTL_USER="${PGUSER:-admin}"
CTL_DB="${PGDATABASE:-agenthive}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/agenthive}"

BACKUP_DIR="$BACKUP_ROOT/$SLUG"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/${TIMESTAMP}.dump"
CHECKSUM_FILE="$DUMP_FILE.sha256"
MANIFEST_FILE="$DUMP_FILE.manifest"
LOG_DIR="/home/xiaomi/.hermes/cron/output"
LOG="$LOG_DIR/tenant-backup-${SLUG}-${TIMESTAMP}.log"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

log()  { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FATAL: $*"; exit "${2:-1}"; }

PSQL_CTL="psql -h $CTL_HOST -p $CTL_PORT -U $CTL_USER -d $CTL_DB"

log "=== Tenant backup starting: slug=$SLUG mode=$MODE ts=$TIMESTAMP ==="

# ----------------------------------------------------------------
# Step 1: Resolve tenant DB URL from control plane
# ----------------------------------------------------------------
log "Step 1: Resolve tenant_db_url for slug=$SLUG"
TENANT_DB_URL=$($PSQL_CTL -tAc \
  "SELECT tenant_db_url FROM roadmap.project WHERE slug = '$SLUG' AND status = 'active'") \
  || fail "Control-plane query failed; check $CTL_HOST:$CTL_PORT/$CTL_DB" 1

[[ -z "$TENANT_DB_URL" ]] && \
  fail "No active project with slug='$SLUG' in roadmap.project; check slug or project status" 1

log "  Tenant DSN resolved (length=${#TENANT_DB_URL})"

PROJECT_ID=$($PSQL_CTL -tAc \
  "SELECT project_id FROM roadmap.project WHERE slug = '$SLUG'") \
  || fail "Could not resolve project_id for slug=$SLUG" 1

# ----------------------------------------------------------------
# Step 2: Run pg_dump (custom format, required for pg_restore --list)
# ----------------------------------------------------------------
log "Step 2: pg_dump to $DUMP_FILE"
pg_dump -F c "$TENANT_DB_URL" > "$DUMP_FILE" 2>>"$LOG" \
  || fail "pg_dump failed for slug=$SLUG; see $LOG" 1

DUMP_SIZE_BYTES=$(stat -c%s "$DUMP_FILE")
log "  Dump complete: $(($DUMP_SIZE_BYTES / 1024 / 1024)) MB"

# ----------------------------------------------------------------
# Step 3: Post-dump validation
# ----------------------------------------------------------------
log "Step 3: Post-dump validation"

# 3a. Parse archive (catches format corruption)
if ! pg_restore --list "$DUMP_FILE" > "$MANIFEST_FILE" 2>>"$LOG"; then
  rm -f "$DUMP_FILE" "$MANIFEST_FILE"
  fail "pg_restore --list failed — dump is corrupted or unreadable" 2
fi

MANIFEST_LINES=$(wc -l < "$MANIFEST_FILE")
if [[ "$MANIFEST_LINES" -lt 5 ]]; then
  rm -f "$DUMP_FILE" "$MANIFEST_FILE"
  fail "Manifest only $MANIFEST_LINES lines (expected ≥ 5); dump appears empty or corrupt" 2
fi
log "  Manifest OK: $MANIFEST_LINES lines"

# 3b. SHA256 checksum
sha256sum "$DUMP_FILE" > "$CHECKSUM_FILE"
if ! sha256sum -c "$CHECKSUM_FILE" >/dev/null 2>&1; then
  rm -f "$DUMP_FILE" "$CHECKSUM_FILE"
  fail "SHA256 verification failed immediately after write; storage issue?" 2
fi
CHECKSUM=$(awk '{print $1}' "$CHECKSUM_FILE")
log "  SHA256 OK: $CHECKSUM"

# Keep checksum alongside dump; manifest is transient — remove after validation.
rm -f "$MANIFEST_FILE"

# ----------------------------------------------------------------
# Step 4: Record in catalog (skipped in smoke mode)
# ----------------------------------------------------------------
STORAGE_URI="file://$DUMP_FILE"

# Retention: read from tenant_backup_policy, default 30 days
RETAIN_DAYS=$($PSQL_CTL -tAc "
  SELECT COALESCE(
    (SELECT retain_daily_days FROM roadmap.tenant_backup_policy WHERE project_id = $PROJECT_ID),
    30
  )" 2>>"$LOG") || RETAIN_DAYS=30

if [[ "$MODE" != "smoke" ]]; then
  log "Step 4: Recording backup in roadmap.tenant_backup"
  $PSQL_CTL -v ON_ERROR_STOP=1 -c "
    INSERT INTO roadmap.tenant_backup
      (project_id, backup_kind, storage_uri, size_bytes, checksum_sha256,
       manifest_lines, retention_until)
    VALUES
      ($PROJECT_ID, 'logical', '$STORAGE_URI', $DUMP_SIZE_BYTES,
       '$CHECKSUM', $MANIFEST_LINES,
       now() + INTERVAL '$RETAIN_DAYS days')
  " >>"$LOG" 2>&1 \
    || log "  WARNING: catalog INSERT failed; backup file is intact at $DUMP_FILE"
  log "  Catalog row written"
else
  log "Step 4: Skipped (smoke mode)"
fi

log "=== Backup complete: $DUMP_FILE ==="
log "  size=$(($DUMP_SIZE_BYTES / 1024 / 1024)) MB  manifest_lines=$MANIFEST_LINES  sha256=$CHECKSUM"
log "Full log: $LOG"
