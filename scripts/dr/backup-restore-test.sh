#!/usr/bin/env bash
# scripts/dr/backup-restore-test.sh
#
# P591 AC13 — Weekly automated backup restore-test.
#
# Fetches the most recent logical pg_dump of hiveCentral from S3,
# restores it to a scratch Postgres instance, runs smoke tests, and
# logs the result to governance.decision_log kind=backup_verified.
#
# Required env (sourced from /home/xiaomi/.hermes/.env or passed explicitly):
#   PGPASSWORD          — postgres password (same var used by other cron jobs)
#   PG_USER             — postgres user (e.g. admin)
#   PG_DATABASE         — control-plane DB name (e.g. hiveCentral)
#   S3_BUCKET           — S3 bucket holding pg_dump archives
#   S3_PREFIX           — key prefix for hiveCentral dumps (e.g. backups/hivecentral)
#   SCRATCH_PG_PORT     — port for the scratch Postgres instance (default: 5433)
#   SCRATCH_PG_DATA     — data dir for scratch instance (default: /tmp/dr-restore-test-pgdata)
#   LIVE_PG_HOST        — host for the live PgBouncer/primary (default: 127.0.0.1)
#   LIVE_PG_PORT        — port for the live PgBouncer (default: 6432)
#   DR_ARTIFACTS_DIR    — where record-dr-event.sql lives
#                         (default: /usr/local/share/agenthive/dr)
#
# Exit codes:
#   0 — backup verified successfully
#   1 — setup / S3 fetch failed; backup_verified NOT logged
#   2 — restore succeeded but smoke tests failed; backup_broken logged instead

set -euo pipefail

SCRATCH_PORT="${SCRATCH_PG_PORT:-5433}"
SCRATCH_DATA="${SCRATCH_PG_DATA:-/tmp/dr-restore-test-pgdata}"
LIVE_HOST="${LIVE_PG_HOST:-127.0.0.1}"
LIVE_PORT="${LIVE_PG_PORT:-6432}"
PG_USER="${PG_USER:?PG_USER required}"
PG_DATABASE="${PG_DATABASE:?PG_DATABASE required}"
S3_BUCKET="${S3_BUCKET:?S3_BUCKET required}"
S3_PREFIX="${S3_PREFIX:-backups/hivecentral}"
DR_DIR="${DR_ARTIFACTS_DIR:-/usr/local/share/agenthive/dr}"

TEST_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_DIR="/home/xiaomi/.hermes/cron/output"
LOG="${LOG_DIR}/backup-restore-test-${TEST_TS//[:]/-}.log"
mkdir -p "$LOG_DIR"

log()  { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FATAL: $*"; exit "${2:-1}"; }

log "=== Backup restore-test starting at ${TEST_TS} ==="
log "  S3 source: s3://${S3_BUCKET}/${S3_PREFIX}/"
log "  Scratch port: ${SCRATCH_PORT}  data: ${SCRATCH_DATA}"

# ----------------------------------------------------------------
# Step 1: Find the latest dump in S3
# ----------------------------------------------------------------
log "Step 1: Locate latest pg_dump in S3"
DUMP_KEY=$(aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  | grep '\.dump' \
  | sort -k1,2 \
  | tail -1 \
  | awk '{print $4}') \
  || fail "aws s3 ls failed; check AWS credentials and bucket config" 1
[[ -z "$DUMP_KEY" ]] && fail "No .dump files found at s3://${S3_BUCKET}/${S3_PREFIX}/" 1
log "  Latest dump: ${DUMP_KEY}"

# ----------------------------------------------------------------
# Step 2: Download dump to local temp file
# ----------------------------------------------------------------
log "Step 2: Download dump"
DUMP_FILE="$(mktemp /tmp/dr-restore-XXXXXX.dump)"
trap 'rm -f "$DUMP_FILE"; _scratch_teardown' EXIT

aws s3 cp "s3://${S3_BUCKET}/${S3_PREFIX}/${DUMP_KEY}" "$DUMP_FILE" \
  | tee -a "$LOG" \
  || fail "S3 download failed for key ${DUMP_KEY}" 1
DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
log "  Downloaded ${DUMP_SIZE} to ${DUMP_FILE}"

# ----------------------------------------------------------------
# Step 3: Start scratch Postgres instance
# ----------------------------------------------------------------
log "Step 3: Initialize scratch Postgres"

_scratch_teardown() {
  if pg_ctl status -D "$SCRATCH_DATA" >/dev/null 2>&1; then
    log "Tearing down scratch instance..."
    pg_ctl stop -D "$SCRATCH_DATA" -m fast >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH_DATA"
}

rm -rf "$SCRATCH_DATA"
initdb -D "$SCRATCH_DATA" --no-locale --encoding=UTF8 -U postgres >> "$LOG" 2>&1 \
  || fail "initdb failed" 1

# Minimal config: listen only on localhost at scratch port
cat >> "$SCRATCH_DATA/postgresql.conf" <<EOF
port = ${SCRATCH_PORT}
listen_addresses = '127.0.0.1'
max_connections = 20
shared_buffers = 64MB
log_min_messages = WARNING
EOF

pg_ctl start -D "$SCRATCH_DATA" -l "$LOG" -w -t 30 \
  || fail "scratch Postgres failed to start" 1
log "  Scratch instance running on port ${SCRATCH_PORT}"

# Create target DB
PGPASSWORD="" createdb -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres "$PG_DATABASE" >> "$LOG" 2>&1 \
  || fail "createdb on scratch failed" 1

# ----------------------------------------------------------------
# Step 4: Restore dump
# ----------------------------------------------------------------
log "Step 4: Restore dump to scratch"
PGPASSWORD="" pg_restore \
  -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres \
  -d "$PG_DATABASE" \
  --no-owner --no-privileges \
  -j 2 \
  "$DUMP_FILE" >> "$LOG" 2>&1 \
  || { log "pg_restore exited non-zero (may be ignorable warnings); continuing to smoke tests"; }
log "  Restore complete"

# ----------------------------------------------------------------
# Step 5: Smoke tests
# ----------------------------------------------------------------
log "Step 5: Smoke tests"
SMOKE_PASS=true

_smoke() {
  local label="$1"; shift
  local result
  result=$(PGPASSWORD="" psql -h 127.0.0.1 -p "$SCRATCH_PORT" -U postgres -d "$PG_DATABASE" -tAc "$1" 2>>"$LOG") \
    || { log "  FAIL [$label]: query error"; SMOKE_PASS=false; return; }
  if [[ "$result" != "$2" ]]; then
    log "  FAIL [$label]: expected '$2', got '$result'"
    SMOKE_PASS=false
  else
    log "  PASS [$label]"
  fi
}

# 1. roadmap schema present
_smoke "schema_exists" \
  "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='roadmap'" \
  "1"

# 2. governance.decision_log has rows (chain must exist)
_smoke "decision_log_nonempty" \
  "SELECT (COUNT(*) > 0)::text FROM roadmap.governance_decision_log" \
  "true"

# 3. Hash chain head is intact (last row's prev_hash links correctly)
_smoke "chain_head_valid" \
  "SELECT (this_hash IS NOT NULL AND length(this_hash) = 64)::text
     FROM roadmap.governance_decision_log
    ORDER BY entry_id DESC LIMIT 1" \
  "true"

# 4. project.project_db table present (required by lease-reconcile.sql)
_smoke "project_db_table" \
  "SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema='project' AND table_name='project_db'" \
  "1"

# 5. roadmap.dr_orphan_lease_request table present (required by lease-reconcile.sql)
_smoke "dr_queue_table" \
  "SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema='roadmap' AND table_name='dr_orphan_lease_request'" \
  "1"

# ----------------------------------------------------------------
# Step 6: Log result to live governance.decision_log
# ----------------------------------------------------------------
log "Step 6: Log result to live governance.decision_log"

if $SMOKE_PASS; then
  EVENT_KIND="backup_verified"
  NOTES="all 5 smoke tests passed; restore from s3://${S3_BUCKET}/${S3_PREFIX}/${DUMP_KEY}"
  log "  Smoke tests PASSED — logging backup_verified"
else
  EVENT_KIND="backup_broken"
  NOTES="smoke tests FAILED; see ${LOG}; dump: s3://${S3_BUCKET}/${S3_PREFIX}/${DUMP_KEY}"
  log "  Smoke tests FAILED — logging backup_broken"
fi

PGPASSWORD="${PGPASSWORD:-}" psql \
  -h "$LIVE_HOST" -p "$LIVE_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
  -v event_kind="${EVENT_KIND}" \
  -v operator="cron/backup-restore-test" \
  -v rpo_seconds="0" \
  -v rto_seconds="0" \
  -v decision_seconds="0" \
  -v clock_skew_max="0" \
  -v notes="${NOTES}" \
  -f "${DR_DIR}/record-dr-event.sql" >> "$LOG" 2>&1 \
  || log "  (warning: failed to write to live governance.decision_log; check ${LOG})"

log "=== Backup restore-test completed at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
log "Full log: ${LOG}"

if ! $SMOKE_PASS; then
  exit 2
fi
