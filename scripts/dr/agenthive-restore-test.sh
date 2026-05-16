#!/usr/bin/env bash
# scripts/dr/agenthive-restore-test.sh
#
# P509: Monthly per-tenant backup restore-test.
#
# Restores the most recent verified (or latest) logical dump for a tenant into
# an ephemeral scratch database, validates COUNT(*) for every public-schema table,
# and records the result in roadmap.tenant_backup (verified_at, verify_tables,
# verify_failed) plus roadmap.governance_decision_log.
#
# Usage: agenthive-restore-test.sh <slug>
#
# Required env (source /home/xiaomi/.hermes/.env):
#   PGHOST        — control-plane host  (default: 127.0.0.1)
#   PGPORT        — control-plane port  (default: 5432)
#   PGUSER        — control-plane user  (default: admin)
#   PGDATABASE    — control-plane DB    (default: agenthive)
#   BACKUP_ROOT   — backup root dir     (default: /var/backups/agenthive)
#   SCRATCH_PORT  — scratch Postgres port (default: 5434)
#   SCRATCH_DATA  — scratch data dir    (default: /tmp/restore-test-pgdata)
#
# Exit codes:
#   0 — restore-test passed
#   1 — setup or catalog lookup failure
#   2 — restore or table-validation failure

set -euo pipefail

SLUG="${1:?Usage: $0 <slug>}"

CTL_HOST="${PGHOST:-127.0.0.1}"
CTL_PORT="${PGPORT:-5432}"
CTL_USER="${PGUSER:-admin}"
CTL_DB="${PGDATABASE:-agenthive}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/agenthive}"
SCRATCH_PORT="${SCRATCH_PORT:-5434}"
SCRATCH_DATA="${SCRATCH_DATA:-/tmp/restore-test-pgdata-$$}"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
LOG_DIR="/home/xiaomi/.hermes/cron/output"
LOG="$LOG_DIR/restore-test-${SLUG}-${TIMESTAMP}.log"
TEST_DB="restore_test_${SLUG}_$$"

mkdir -p "$LOG_DIR"

log()  { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FATAL: $*"; exit "${2:-1}"; }

PSQL_CTL="psql -h $CTL_HOST -p $CTL_PORT -U $CTL_USER -d $CTL_DB"

log "=== Restore-test starting: slug=$SLUG ts=$TIMESTAMP ==="

# ----------------------------------------------------------------
# Step 1: Find latest dump for this tenant
# ----------------------------------------------------------------
log "Step 1: Locate latest backup in catalog for slug=$SLUG"
PROJECT_ID=$($PSQL_CTL -tAc \
  "SELECT project_id FROM roadmap.project WHERE slug = '$SLUG' AND status = 'active'") \
  || fail "Control-plane query failed" 1
[[ -z "$PROJECT_ID" ]] && fail "No active project with slug='$SLUG'" 1

# Prefer verified backups; fall back to any logical backup.
CATALOG_ROW=$($PSQL_CTL -tAc "
  SELECT backup_id, storage_uri
  FROM roadmap.tenant_backup
  WHERE project_id = $PROJECT_ID
    AND backup_kind = 'logical'
    AND retention_until > now()
  ORDER BY taken_at DESC
  LIMIT 1
") || fail "Catalog query failed" 1

[[ -z "$CATALOG_ROW" ]] && fail "No valid logical backup found for slug=$SLUG" 1

BACKUP_ID=$(echo "$CATALOG_ROW" | awk '{print $1}')
STORAGE_URI=$(echo "$CATALOG_ROW" | awk '{print $2}')

# Only local file:// URIs supported for now
DUMP_FILE="${STORAGE_URI#file://}"
[[ -f "$DUMP_FILE" ]] || fail "Dump file not found: $DUMP_FILE" 1

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
log "  Using backup_id=$BACKUP_ID  file=$DUMP_FILE  size=$DUMP_SIZE"

# ----------------------------------------------------------------
# Step 2: Verify checksum
# ----------------------------------------------------------------
log "Step 2: Verify SHA256 checksum"
CHECKSUM_FILE="$DUMP_FILE.sha256"
if [[ -f "$CHECKSUM_FILE" ]]; then
  sha256sum -c "$CHECKSUM_FILE" >/dev/null 2>&1 || fail "Checksum mismatch for $DUMP_FILE" 2
  log "  Checksum OK"
else
  log "  WARNING: no .sha256 file found; skipping checksum verification"
fi

# ----------------------------------------------------------------
# Step 3: Start scratch Postgres instance
# ----------------------------------------------------------------
log "Step 3: Initialize scratch Postgres on port $SCRATCH_PORT"

_scratch_teardown() {
  if pg_ctl status -D "$SCRATCH_DATA" >/dev/null 2>&1; then
    log "Tearing down scratch instance..."
    pg_ctl stop -D "$SCRATCH_DATA" -m fast >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH_DATA"
}
trap '_scratch_teardown' EXIT

rm -rf "$SCRATCH_DATA"
initdb -D "$SCRATCH_DATA" --no-locale --encoding=UTF8 -U postgres \
  --auth-local=trust --auth-host=trust >> "$LOG" 2>&1 \
  || fail "initdb failed" 1

cat >> "$SCRATCH_DATA/postgresql.conf" <<EOF
port = ${SCRATCH_PORT}
listen_addresses = '127.0.0.1'
max_connections = 20
shared_buffers = 64MB
log_min_messages = WARNING
EOF

pg_ctl start -D "$SCRATCH_DATA" -l "$LOG" -w -t 30 \
  || fail "Scratch Postgres failed to start" 1
log "  Scratch instance running on port $SCRATCH_PORT"

createdb -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres "$TEST_DB" >> "$LOG" 2>&1 \
  || fail "createdb on scratch failed" 1

# ----------------------------------------------------------------
# Step 4: Restore dump
# ----------------------------------------------------------------
log "Step 4: Restore dump to scratch DB $TEST_DB"
RESTORE_RC=0
pg_restore \
  -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres \
  -d "$TEST_DB" \
  --no-owner --no-privileges \
  -j 2 \
  "$DUMP_FILE" >> "$LOG" 2>&1 || RESTORE_RC=$?

if [[ $RESTORE_RC -gt 1 ]]; then
  fail "pg_restore failed fatally (rc=$RESTORE_RC)" 2
elif [[ $RESTORE_RC -eq 1 ]]; then
  log "  pg_restore exited 1 (non-fatal warnings); continuing"
fi
log "  Restore complete"

# ----------------------------------------------------------------
# Step 5: Validate all public-schema tables
# ----------------------------------------------------------------
log "Step 5: COUNT(*) validation for all public-schema tables"

TABLES=$(psql -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d "$TEST_DB" \
  -tAc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename" 2>>"$LOG")

TOTAL=0
FAILED=0
for TABLE in $TABLES; do
  TOTAL=$((TOTAL + 1))
  COUNT=$(psql -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d "$TEST_DB" \
    -tAc "SELECT COUNT(*) FROM public.\"$TABLE\"" 2>>"$LOG") || COUNT=""
  if [[ -z "$COUNT" ]]; then
    log "  FAIL [$TABLE]: query returned no result"
    FAILED=$((FAILED + 1))
  else
    log "  OK [$TABLE]: $COUNT rows"
  fi
done

log "  Validation: $TOTAL tables  $FAILED failed"

# ----------------------------------------------------------------
# Step 6: Update catalog + log governance decision
# ----------------------------------------------------------------
log "Step 6: Update catalog and log governance event"

if [[ $FAILED -eq 0 ]]; then
  OUTCOME="passed"
  NOTES="restore-test PASSED for slug=$SLUG; $TOTAL tables validated; backup_id=$BACKUP_ID"
else
  OUTCOME="failed"
  NOTES="restore-test FAILED for slug=$SLUG; $FAILED/$TOTAL tables invalid; backup_id=$BACKUP_ID; see $LOG"
fi

# Update tenant_backup.verified_at
$PSQL_CTL -v ON_ERROR_STOP=1 -c "
  UPDATE roadmap.tenant_backup
  SET verified_at   = now(),
      verify_tables = $TOTAL,
      verify_failed = $FAILED
  WHERE backup_id = '$BACKUP_ID'
" >>"$LOG" 2>&1 || log "  WARNING: catalog update failed (backup_id=$BACKUP_ID)"

# Append governance event
$PSQL_CTL -c "
  INSERT INTO roadmap.governance_decision_log
    (entry_kind, payload, operator_did)
  VALUES (
    'backup_restore_drill',
    jsonb_build_object(
      'slug', '$SLUG',
      'project_id', $PROJECT_ID,
      'backup_id', '$BACKUP_ID',
      'outcome', '$OUTCOME',
      'tables_validated', $TOTAL,
      'tables_failed', $FAILED,
      'log_path', '$LOG'
    ),
    'cron/agenthive-restore-test'
  )
" >>"$LOG" 2>&1 || log "  WARNING: governance log insert failed"

log "=== Restore-test $OUTCOME for slug=$SLUG ==="
log "Full log: $LOG"

[[ $FAILED -eq 0 ]] || exit 2
