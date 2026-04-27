#!/usr/bin/env bash
# P604: Observability data retention — deletes spans older than 30 days.
# Run as admin_write role (which holds DELETE grant on roadmap.trace_span + agent_execution_span).
# agent_execution_span rows are cascade-deleted via span_id FK; only trace_span needs direct DELETE.

set -euo pipefail

DB_HOST="${PGHOST:-127.0.0.1}"
DB_PORT="${PGPORT:-5432}"
DB_NAME="${PGDATABASE:-agenthive}"
DB_USER="${PGUSER:-admin}"
RETENTION_DAYS="${OBSERVABILITY_RETENTION_DAYS:-30}"

PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -v ON_ERROR_STOP=1"

echo "[retention] Deleting observability data older than ${RETENTION_DAYS} days..."

DELETED=$($PSQL -At <<SQL
WITH deleted_root AS (
  DELETE FROM roadmap.trace_span
  WHERE started_at < now() - INTERVAL '${RETENTION_DAYS} days'
  RETURNING span_id
)
SELECT count(*) FROM deleted_root;
SQL
)

echo "[retention] Deleted: $DELETED trace_span(s) (agent_execution_span cascade-deleted)"

# Verify — no rows before the cutoff should remain
REMAINING=$($PSQL -At <<SQL
SELECT count(*)
FROM roadmap.trace_span
WHERE started_at < now() - INTERVAL '${RETENTION_DAYS} days';
SQL
)

if [[ "$REMAINING" -gt 0 ]]; then
  echo "[retention] ERROR: $REMAINING rows remain before cutoff — check DELETE permissions" >&2
  exit 1
fi

echo "[retention] Verification passed — no rows before cutoff remain."
