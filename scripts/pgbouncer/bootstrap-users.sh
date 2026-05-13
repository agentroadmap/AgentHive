#!/usr/bin/env bash
# P499: Bootstrap PgBouncer userlist from Postgres pg_shadow.
#
# Generates /etc/pgbouncer/userlist.txt with scram-sha-256 hashes for
# agenthive_admin and agenthive_app roles.
#
# Usage:
#   sudo scripts/pgbouncer/bootstrap-users.sh
#
# Full saga (key rotation, expiry, multi-tenant sync) is tracked in P509.
# This script is the minimal P499 bootstrap only.
#
# Requires: psql with access to pg_shadow (superuser or pg_read_all_settings).
# Reads PG credentials from env or ~/.pgpass as usual.

set -euo pipefail

USERLIST_PATH="${USERLIST_PATH:-/etc/pgbouncer/userlist.txt}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT_DIRECT="${PGPORT_DIRECT:-${PGPORT:-5432}}"
PGUSER="${PGUSER:-xiaomi}"
PGDATABASE="${PGDATABASE:-agenthive}"

ROLES=("agenthive_admin" "agenthive_app")

echo "Bootstrapping PgBouncer userlist at ${USERLIST_PATH}"
echo "Source: ${PGHOST}:${PGPORT_DIRECT}/${PGDATABASE}"

# Build userlist.txt from pg_shadow
TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

for role in "${ROLES[@]}"; do
    passwd="$(PGPORT="${PGPORT_DIRECT}" psql \
        -h "${PGHOST}" \
        -U "${PGUSER}" \
        -d "${PGDATABASE}" \
        -tAc "SELECT passwd FROM pg_shadow WHERE usename = '${role}'" 2>/dev/null || true)"

    if [[ -z "$passwd" ]]; then
        echo "WARNING: role '${role}' not found in pg_shadow — skipping" >&2
        continue
    fi

    echo "\"${role}\" \"${passwd}\"" >> "$TMPFILE"
    echo "  + wrote ${role}"
done

if [[ ! -s "$TMPFILE" ]]; then
    echo "ERROR: no roles written — userlist will be empty" >&2
    exit 1
fi

# Install with restricted permissions (PgBouncer requires 0600 owner:pgbouncer)
install -o pgbouncer -g pgbouncer -m 0600 "$TMPFILE" "${USERLIST_PATH}"
echo "Installed ${USERLIST_PATH}"

# Reload live bouncer if running
if systemctl is-active --quiet pgbouncer 2>/dev/null; then
    systemctl reload pgbouncer
    echo "Reloaded pgbouncer"
fi
