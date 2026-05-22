#!/usr/bin/env bash
set -euo pipefail

retention="${1:-14 days}"

export PGUSER="${PGUSER:-${PG_USER:-admin}}"
export PGDATABASE="${PGDATABASE:-${PG_DATABASE:-agenthive}}"

deleted="$(
  psql -X -v ON_ERROR_STOP=1 -Atc \
    "SELECT roadmap_workforce.fn_reap_stale_registry('${retention}'::interval);"
)"

printf '[agent-registry-reaper] retention=%s reaped=%s\n' "$retention" "$deleted"
