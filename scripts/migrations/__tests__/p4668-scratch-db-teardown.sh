#!/usr/bin/env bash
# P4668 AC-21 — tear down the isolated scratch DB created by p4668-scratch-db-setup.sh.
#
# Usage:
#   PGPASSWORD=<pass> bash scripts/migrations/__tests__/p4668-scratch-db-teardown.sh
#
# Env vars:
#   PGHOST / PGPORT / PGUSER   — connection defaults (127.0.0.1 / 5432 / admin)
#   PGDATABASE                 — scratch DB to drop (default: agenthive_p4668_test)
#   PGADMIN_DB                 — admin DB to connect for DROP (default: postgres)
set -euo pipefail

SCRATCH_DB="${PGDATABASE:-agenthive_p4668_test}"
ADMIN_DB="${PGADMIN_DB:-postgres}"
HOST="${PGHOST:-127.0.0.1}"
PORT="${PGPORT:-5432}"
USER="${PGUSER:-admin}"

echo "[p4668-teardown] Dropping scratch DB '$SCRATCH_DB' ..."
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$ADMIN_DB" \
  -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\""
echo "[p4668-teardown] Done."
