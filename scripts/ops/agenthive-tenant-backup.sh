#!/usr/bin/env bash
# scripts/ops/agenthive-tenant-backup.sh
#
# P509 — Per-tenant pg_dump with post-dump validation.
#
# Usage:
#   agenthive-tenant-backup.sh <slug> [prod|smoke]
#
# Mode:
#   prod  — dump to /var/backups/agenthive/<slug>/
#   smoke — dump to /var/backups/agenthive/<slug>/.smoke/ (auto-cleaned on success)
#
# DSN resolution (first match wins):
#   1. AGENTHIVE_TENANT_<SLUG>_DSN environment variable (slug uppercased, hyphens→underscores)
#   2. vault kv get -field=pg_dsn secret/agenthive/tenant/<slug>
#
# Escalation: on failure, inserts a row into roadmap.escalation_log via psql.
# Auth: uses ~/.pgpass for the control-plane DB; never PGPASSWORD= in environment.
#
# Exit codes:
#   0 — dump validated successfully
#   1 — pg_dump failed
#   2 — validation failed (corrupted dump)
#   3 — bad arguments

set -euo pipefail

SLUG="${1:?Usage: $0 <slug> [prod|smoke]}"
MODE="${2:-prod}"

if [[ "$MODE" != "prod" && "$MODE" != "smoke" ]]; then
  echo "ERROR: MODE must be 'prod' or 'smoke', got: $MODE" >&2
  exit 3
fi

LOG_DIR="/var/log/agenthive"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/backup-${SLUG}.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

# ── DSN resolution ─────────────────────────────────────────────────────────────
SLUG_ENV="${SLUG//-/_}"
SLUG_ENV="${SLUG_ENV^^}"
DSN_VAR="AGENTHIVE_TENANT_${SLUG_ENV}_DSN"

if [[ -n "${!DSN_VAR:-}" ]]; then
  DSN="${!DSN_VAR}"
elif command -v vault >/dev/null 2>&1; then
  DSN=$(vault kv get -field=pg_dsn "secret/agenthive/tenant/${SLUG}" 2>>"$LOG") || {
    log "ERROR: vault lookup failed for slug=${SLUG}; set ${DSN_VAR} or configure vault"
    exit 1
  }
else
  log "ERROR: no DSN found for ${SLUG}. Set env var ${DSN_VAR} or install vault."
  exit 1
fi

# ── Paths ──────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "smoke" ]]; then
  BACKUP_DIR="/var/backups/agenthive/${SLUG}/.smoke"
else
  BACKUP_DIR="/var/backups/agenthive/${SLUG}"
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/${TIMESTAMP}.dump"
CHECKSUM_FILE="${DUMP_FILE}.sha256"
MANIFEST_FILE="${DUMP_FILE}.manifest"

# ── Control-plane DSN for escalation_log ───────────────────────────────────────
CONTROL_DSN="${AGENTHIVE_CONTROL_DSN:-}"
# Fall back to vault if not set
if [[ -z "$CONTROL_DSN" ]] && command -v vault >/dev/null 2>&1; then
  CONTROL_DSN=$(vault kv get -field=pg_dsn secret/agenthive/control 2>/dev/null || true)
fi

_escalate() {
  local msg="$1"
  log "ESCALATING: $msg"
  if [[ -n "$CONTROL_DSN" ]]; then
    psql "$CONTROL_DSN" -v ON_ERROR_STOP=0 -c "
      INSERT INTO roadmap.escalation_log
        (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
      VALUES
        ('BACKUP_FAILURE', 'P509', 'cron/tenant-backup', 'ops', 'high',
         '$(echo "$msg" | sed "s/'/''/g") — slug=${SLUG} mode=${MODE}')
      ON CONFLICT DO NOTHING;
    " >>"$LOG" 2>&1 || log "WARNING: escalation_log insert failed (control DSN unavailable)"
  fi
}

# ── Step 1: pg_dump ────────────────────────────────────────────────────────────
log "=== Tenant backup: slug=${SLUG} mode=${MODE} ==="
log "  dump target: ${DUMP_FILE}"

if ! pg_dump -F c "$DSN" > "$DUMP_FILE" 2>>"$LOG"; then
  _escalate "pg_dump failed for slug=${SLUG}"
  rm -f "$DUMP_FILE"
  exit 1
fi

DUMP_SIZE_BYTES=$(stat -c%s "$DUMP_FILE" 2>/dev/null || echo 0)
log "  pg_dump OK — $(( DUMP_SIZE_BYTES / 1024 / 1024 )) MB"

# ── Step 2: pg_restore --list (archive parse) ──────────────────────────────────
log "  validating archive with pg_restore --list..."
if ! pg_restore --list "$DUMP_FILE" > "$MANIFEST_FILE" 2>>"$LOG"; then
  _escalate "pg_restore --list failed — dump corrupted for slug=${SLUG}"
  rm -f "$DUMP_FILE" "$MANIFEST_FILE"
  exit 2
fi

# ── Step 3: manifest row count > 5 ────────────────────────────────────────────
MANIFEST_LINES=$(wc -l < "$MANIFEST_FILE")
if [[ "$MANIFEST_LINES" -lt 5 ]]; then
  _escalate "manifest has ${MANIFEST_LINES} lines (< 5) — dump corrupted for slug=${SLUG}"
  rm -f "$DUMP_FILE" "$MANIFEST_FILE"
  exit 2
fi
log "  manifest OK — ${MANIFEST_LINES} lines"

# ── Step 4: SHA256 ────────────────────────────────────────────────────────────
sha256sum "$DUMP_FILE" > "$CHECKSUM_FILE"

if ! sha256sum -c "$CHECKSUM_FILE" >/dev/null 2>&1; then
  _escalate "SHA256 round-trip verification failed for slug=${SLUG}"
  exit 2
fi
CHECKSUM_HEX=$(awk '{print $1}' "$CHECKSUM_FILE")
log "  SHA256 OK — ${CHECKSUM_HEX:0:16}..."

# ── Step 5: cleanup manifest; smoke mode cleanup ───────────────────────────────
rm -f "$MANIFEST_FILE"

if [[ "$MODE" == "smoke" ]]; then
  rm -f "$DUMP_FILE" "$CHECKSUM_FILE"
  log "  smoke mode: dump + checksum removed after validation"
fi

log "=== Backup PASSED: ${DUMP_FILE} ==="
exit 0
