#!/bin/bash
# P675: Schema drift monitor — systemd wrapper for journal scraping + hotfix filing.
set -euo pipefail

source /etc/agenthive/env

export HOME="${HOME:-/home/agenthive}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$PROJECT_ROOT"

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-$USER}"

if [ -z "${PGPASSWORD:-}" ] && [ -n "${PG_PASSWORD:-}" ]; then
	export PGPASSWORD="$PG_PASSWORD"
fi
if [ -z "${PG_PASSWORD:-}" ] && [ -n "${PGPASSWORD:-}" ]; then
	export PG_PASSWORD="$PGPASSWORD"
fi
export PGPASSWORD="${PGPASSWORD:?PGPASSWORD or PG_PASSWORD must be set in /etc/agenthive/env}"

echo "[$(date)] P675 schema-drift monitor cycle starting..."
exec node --import jiti/register scripts/run-schema-drift-monitor.ts
