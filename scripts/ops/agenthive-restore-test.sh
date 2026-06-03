#!/usr/bin/env bash
# scripts/ops/agenthive-restore-test.sh
#
# P509 — Monthly ephemeral restore validation per tenant.
#
# Restores the latest pg_dump into a temporary database, runs COUNT(*) on every
# public-schema table, and drops the ephemeral DB on cleanup.
#
# Usage:
#   agenthive-restore-test.sh <slug>
#
# Required env / ~/.pgpass:
#   AGENTHIVE_CONTROL_DSN       — control-plane connection string (or vault fallback)
#   AGENTHIVE_TENANT_<SLUG>_DSN — tenant DSN (used only to locate existing backup dir)
#
# Exit codes:
#   0 — restore + all table counts passed
#   1 — setup error (no dump found, DB create failed, etc.)
#   2 — restore succeeded but table validation failed
#   3 — bad arguments

set -euo pipefail

SLUG="${1:?Usage: $0 <slug>}"

LOG_DIR="/var/log/agenthive"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/restore-test-${SLUG}.log"
TEST_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== Restore test: slug=${SLUG} started at ${TEST_TS} ==="

# ── Control DSN ───────────────────────────────────────────────────────────────
CONTROL_DSN="${AGENTHIVE_CONTROL_DSN:-}"
if [[ -z "$CONTROL_DSN" ]] && command -v vault >/dev/null 2>&1; then
  CONTROL_DSN=$(vault kv get -field=pg_dsn secret/agenthive/control 2>>"$LOG") || {
    log "ERROR: vault lookup failed for control DSN"
    exit 1
  }
fi
if [[ -z "$CONTROL_DSN" ]]; then
  log "ERROR: AGENTHIVE_CONTROL_DSN not set and vault unavailable"
  exit 1
fi

_escalate() {
  local msg="$1"
  log "ESCALATING: $msg"
  psql "$CONTROL_DSN" -v ON_ERROR_STOP=0 -c "
    INSERT INTO roadmap.escalation_log
      (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
    VALUES
      ('RESTORE_TEST_FAILURE', 'P509', 'cron/restore-test', 'ops', 'high',
       '$(echo "$msg" | sed "s/'/''/g") — slug=${SLUG}')
    ON CONFLICT DO NOTHING;
  " >>"$LOG" 2>&1 || log "WARNING: escalation_log insert failed"
}

# ── Find latest dump ──────────────────────────────────────────────────────────
BACKUP_DIR="/var/backups/agenthive/${SLUG}"
LATEST_DUMP=$(ls -t "${BACKUP_DIR}"/*.dump 2>/dev/null | grep -v '\.smoke/' | head -1 || true)

if [[ -z "$LATEST_DUMP" ]]; then
  MSG="No dump found for slug=${SLUG} in ${BACKUP_DIR}"
  log "ERROR: $MSG"
  _escalate "$MSG"
  exit 1
fi
log "  using dump: ${LATEST_DUMP}"

# ── Verify checksum before restore ────────────────────────────────────────────
CHECKSUM_FILE="${LATEST_DUMP}.sha256"
if [[ -f "$CHECKSUM_FILE" ]]; then
  if ! sha256sum -c "$CHECKSUM_FILE" >/dev/null 2>&1; then
    MSG="SHA256 verification failed for ${LATEST_DUMP}"
    log "ERROR: $MSG"
    _escalate "$MSG"
    exit 1
  fi
  log "  SHA256 pre-restore check OK"
else
  log "  WARNING: no checksum file found; skipping pre-restore integrity check"
fi

# ── Create ephemeral test DB ───────────────────────────────────────────────────
TEST_DB="agenthive_restore_test_${SLUG//-/_}_$(date +%s)"
log "  creating ephemeral DB: ${TEST_DB}"

if ! psql "$CONTROL_DSN" -c "CREATE DATABASE \"${TEST_DB}\"" >>"$LOG" 2>&1; then
  MSG="Failed to CREATE DATABASE ${TEST_DB}"
  log "ERROR: $MSG"
  _escalate "$MSG"
  exit 1
fi

# Strip dbname from control DSN and append test DB name
RESTORE_DSN="${CONTROL_DSN%/*}/${TEST_DB}"

_cleanup() {
  log "  dropping ephemeral DB: ${TEST_DB}"
  psql "$CONTROL_DSN" -c "DROP DATABASE IF EXISTS \"${TEST_DB}\"" >>"$LOG" 2>&1 || true
}
trap _cleanup EXIT

# ── Restore dump ───────────────────────────────────────────────────────────────
log "  restoring dump..."
RESTORE_RC=0
pg_restore -d "$RESTORE_DSN" --no-owner --no-privileges -j 2 "$LATEST_DUMP" >>"$LOG" 2>&1 || RESTORE_RC=$?

# pg_restore exits 1 for non-fatal warnings; only abort on >=2
if [[ "$RESTORE_RC" -ge 2 ]]; then
  MSG="pg_restore exited ${RESTORE_RC} (fatal) for slug=${SLUG}"
  log "ERROR: $MSG"
  _escalate "$MSG"
  exit 2
fi
[[ "$RESTORE_RC" -eq 1 ]] && log "  pg_restore exited 1 (non-fatal warnings); proceeding"
log "  restore complete"

# ── Validate: COUNT(*) per public-schema table ─────────────────────────────────
log "  validating public schema tables..."
TABLES=$(psql "$RESTORE_DSN" -At -c "SELECT tablename FROM pg_tables WHERE schemaname='public'" 2>>"$LOG")

if [[ -z "$TABLES" ]]; then
  MSG="No public-schema tables found in restored DB for slug=${SLUG}"
  log "ERROR: $MSG"
  _escalate "$MSG"
  exit 2
fi

FAILED=0
TABLE_COUNT=0
for TABLE in $TABLES; do
  TABLE_COUNT=$(( TABLE_COUNT + 1 ))
  COUNT=$(psql "$RESTORE_DSN" -At -c "SELECT COUNT(*) FROM \"${TABLE}\"" 2>>"$LOG" || echo "ERROR")
  if [[ -z "$COUNT" || "$COUNT" == "ERROR" ]]; then
    log "  FAIL: ${TABLE} — COUNT(*) returned error"
    FAILED=$(( FAILED + 1 ))
  else
    log "  OK: ${TABLE} — ${COUNT} rows"
  fi
done

if [[ "$FAILED" -gt 0 ]]; then
  MSG="Restore test FAILED for slug=${SLUG}: ${FAILED}/${TABLE_COUNT} tables invalid"
  log "ERROR: $MSG"
  _escalate "$MSG"
  exit 2
fi

log "=== Restore test PASSED: slug=${SLUG} (${TABLE_COUNT} tables validated) ==="
exit 0
