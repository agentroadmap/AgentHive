#!/usr/bin/env bash
# P4668 AC-21 — provision an isolated scratch DB for canonical ledger tests.
#
# Creates agenthive_p4668_test (or $PGDATABASE) from a schema-only dump of
# the source DB, then applies P4668 migrations 306-315.  The scratch DB has
# the full proposal/workforce/roadmap schema including workflow_templates, so
# tests that require workflows can run without hitting agenthive_p3563_test
# (which is missing that table).
#
# Usage:
#   PGPASSWORD=<pass> bash scripts/migrations/__tests__/p4668-scratch-db-setup.sh
#
# Override any default with env vars:
#   PGHOST / PGPORT / PGUSER   — connection defaults (127.0.0.1 / 5432 / admin)
#   PGDATABASE                 — scratch DB name (default: agenthive_p4668_test)
#   PGSRCDB                    — source DB to dump schema from (default: agenthive)
#   PGADMIN_DB                 — admin DB to connect for CREATE DATABASE (default: postgres)
#
# Pair with p4668-scratch-db-teardown.sh to destroy the scratch DB after tests.
set -euo pipefail

SCRATCH_DB="${PGDATABASE:-agenthive_p4668_test}"
ADMIN_DB="${PGADMIN_DB:-postgres}"
HOST="${PGHOST:-127.0.0.1}"
PORT="${PGPORT:-5432}"
USER="${PGUSER:-admin}"
SRC_DB="${PGSRCDB:-agenthive}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "[p4668-setup] Creating scratch DB '$SCRATCH_DB' ..."
if psql -h "$HOST" -p "$PORT" -U "$USER" -d "$ADMIN_DB" \
     -c "CREATE DATABASE \"${SCRATCH_DB}\"" 2>/dev/null; then
  echo "[p4668-setup] Created."
else
  echo "[p4668-setup] DB already exists — dropping and recreating ..."
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$ADMIN_DB" \
    -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\""
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$ADMIN_DB" \
    -c "CREATE DATABASE \"${SCRATCH_DB}\""
fi

echo "[p4668-setup] Applying schema-only dump from '$SRC_DB' ..."
# --no-owner: avoid ownership errors on the scratch DB
# --no-privileges: skip GRANT/REVOKE on pre-existing objects (migrations apply their own)
pg_dump -h "$HOST" -p "$PORT" -U "$USER" -d "$SRC_DB" \
  --schema-only --no-owner --no-privileges \
  | psql -h "$HOST" -p "$PORT" -U "$USER" -d "$SCRATCH_DB" -q

echo "[p4668-setup] Applying P4668 migrations 306-315 ..."
MIGRATIONS=(
  "306-p4668-transition-ledger-ddl.sql"
  "307-p4668-ledger-event-fk.sql"
  "308-p4668-extend-event-type-check.sql"
  "309-p4668-maturity-transitions-check.sql"
  "310-p4668-dual-write-shim.sql"
  "311-p4668-enforcement.sql"
  "312-p4668-break-glass.sql"
  "313-p4668-timeline-view.sql"
  "314-p4668-fn-idempotency-fix.sql"
  "315-p4668-state-reconstruction.sql"
)

for mig in "${MIGRATIONS[@]}"; do
  mig_path="$MIG_DIR/$mig"
  if [[ ! -f "$mig_path" ]]; then
    echo "[p4668-setup] ERROR: migration not found: $mig_path" >&2
    exit 1
  fi
  echo "  [p4668-setup] applying $mig ..."
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$SCRATCH_DB" -f "$mig_path" -q
done

echo "[p4668-setup] Done. Scratch DB '$SCRATCH_DB' is ready for P4668 tests."
echo "[p4668-setup] Run tests:"
echo "  AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=$SCRATCH_DB \\"
echo "    npx vitest run scripts/migrations/__tests__/p4668-transition-ledger.test.ts"
echo "[p4668-setup] Tear down with:"
echo "  PGDATABASE=$SCRATCH_DB bash scripts/migrations/__tests__/p4668-scratch-db-teardown.sh"
