#!/usr/bin/env bash
# scripts/ops/pgbouncer-provision.sh
#
# P499 — Install and configure PgBouncer as a transaction-mode pooler in front
# of PostgreSQL for AgentHive tenant + control pool fanout.
#
# This script is idempotent: re-running updates config and reloads without
# restarting active connections.
#
# Usage:
#   sudo scripts/ops/pgbouncer-provision.sh [--dry-run]
#
# Prerequisites:
#   - pgbouncer package installed (apt install pgbouncer)
#   - PostgreSQL running on 127.0.0.1:5432
#   - Auth: pgbouncer admin user password must be in ~/.pgpass (never PGPASSWORD=)
#
# What it does:
#   1. Creates pgbouncer system user (if absent)
#   2. Writes /etc/pgbouncer/pgbouncer.ini (transaction-mode, :6432)
#   3. Writes /etc/pgbouncer/userlist.txt (scram-sha-256 hashes from pg_authid)
#   4. Installs scripts/systemd/pgbouncer.service → /etc/systemd/system/
#   5. systemctl daemon-reload + enable + (re)start
#
# LISTEN bypass:
#   Clients that need LISTEN/NOTIFY must connect directly to :5432 by setting
#   PGPORT_DIRECT=5432 (used by pool-registry.ts ensureListenConnection).
#
# Exit codes:
#   0 — success
#   1 — fatal error

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[dry-run] No changes will be written."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PGBOUNCER_USER="pgbouncer"
PGBOUNCER_GROUP="pgbouncer"
PGBOUNCER_CONF_DIR="/etc/pgbouncer"
PGBOUNCER_INI="${PGBOUNCER_CONF_DIR}/pgbouncer.ini"
PGBOUNCER_USERLIST="${PGBOUNCER_CONF_DIR}/userlist.txt"
PGBOUNCER_LOG_DIR="/var/log/pgbouncer"
SERVICE_SRC="${REPO_ROOT}/scripts/systemd/pgbouncer.service"
SERVICE_DEST="/etc/systemd/system/pgbouncer.service"

PGBOUNCER_LISTEN_PORT="${PGBOUNCER_LISTEN_PORT:-6432}"
PGBOUNCER_ADMIN_USER="${PGBOUNCER_ADMIN_USER:-pgbouncer_admin}"
PG_HOST="${PGHOST:-127.0.0.1}"
PG_PORT="${PGPORT_DIRECT:-5432}"
PG_STATS_USERS="${PGBOUNCER_STATS_USERS:-agenthive,pgbouncer_admin}"

run() {
  if $DRY_RUN; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "==> [P499] PgBouncer provisioning starting"
echo "    Repo root : ${REPO_ROOT}"
echo "    INI target: ${PGBOUNCER_INI}"
echo "    Listen    : ${PGBOUNCER_LISTEN_PORT} → PG ${PG_HOST}:${PG_PORT}"

# ── 1. System user ────────────────────────────────────────────────────────────
if ! id -u "${PGBOUNCER_USER}" &>/dev/null; then
  echo "==> Creating system user ${PGBOUNCER_USER}"
  run useradd -r -s /usr/sbin/nologin -d /var/lib/pgbouncer "${PGBOUNCER_USER}"
else
  echo "    User ${PGBOUNCER_USER} already exists."
fi

# ── 2. Directories ────────────────────────────────────────────────────────────
echo "==> Creating directories"
run install -d -o "${PGBOUNCER_USER}" -g "${PGBOUNCER_GROUP}" -m 0755 "${PGBOUNCER_CONF_DIR}"
run install -d -o "${PGBOUNCER_USER}" -g "${PGBOUNCER_GROUP}" -m 0755 "${PGBOUNCER_LOG_DIR}"

# ── 3. pgbouncer.ini ─────────────────────────────────────────────────────────
echo "==> Writing ${PGBOUNCER_INI}"
INI_CONTENT="[databases]
# Route all databases to the local Postgres instance.
# Specific tenant overrides can be added below in the form:
#   <dbname> = host=<host> port=<port> dbname=<dbname>
* = host=${PG_HOST} port=${PG_PORT}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${PGBOUNCER_LISTEN_PORT}

# Transaction mode is required for per-request pooling.
# LISTEN/NOTIFY is NOT supported in transaction mode — use PGPORT_DIRECT=5432 bypass.
pool_mode = transaction

# Auth
auth_type = scram-sha-256
auth_file = ${PGBOUNCER_USERLIST}

# Pool sizing
max_client_conn = 200
default_pool_size = 20
min_pool_size = 2
reserve_pool_size = 5
reserve_pool_timeout = 3

# Timeouts (seconds)
server_connect_timeout = 15
server_idle_timeout = 600
client_idle_timeout = 0
query_timeout = 0
query_wait_timeout = 120

# Admin / stats
admin_users = ${PGBOUNCER_ADMIN_USER}
stats_users = ${PG_STATS_USERS}

# PID / logging
pidfile = /run/pgbouncer/pgbouncer.pid
logfile = /var/log/pgbouncer/pgbouncer.log
log_connections = 0
log_disconnections = 0
log_stats = 1
stats_period = 60

# TLS (disabled by default; enable by setting server_tls_sslmode)
server_tls_sslmode = prefer
"

if $DRY_RUN; then
  echo "[dry-run] Would write pgbouncer.ini (${#INI_CONTENT} bytes)"
else
  TMP_INI=$(mktemp)
  printf '%s' "${INI_CONTENT}" >"${TMP_INI}"
  install -o "${PGBOUNCER_USER}" -g "${PGBOUNCER_GROUP}" -m 0640 "${TMP_INI}" "${PGBOUNCER_INI}"
  rm -f "${TMP_INI}"
fi

# ── 4. userlist.txt — scram-sha-256 hashes from pg_authid ─────────────────────
# Auth: read from pg_authid using psql with ~/.pgpass (never PGPASSWORD=).
# Requires the operator user to have SELECT on pg_authid.
echo "==> Generating ${PGBOUNCER_USERLIST} from pg_authid"
if $DRY_RUN; then
  echo "[dry-run] Would run: psql -h ${PG_HOST} -p ${PG_PORT} -U postgres -Atc \"SELECT ...\""
else
  TMP_UL=$(mktemp)
  # Extract scram-sha-256 hashes for all non-system users
  psql -h "${PG_HOST}" -p "${PG_PORT}" -U postgres -Atc \
    "SELECT '\"' || rolname || '\" \"' || COALESCE(rolpassword, '') || '\"'
     FROM pg_authid
     WHERE rolcanlogin AND rolpassword IS NOT NULL
     ORDER BY rolname;" \
    >"${TMP_UL}"
  install -o "${PGBOUNCER_USER}" -g "${PGBOUNCER_GROUP}" -m 0640 "${TMP_UL}" "${PGBOUNCER_USERLIST}"
  rm -f "${TMP_UL}"
  echo "    Wrote $(wc -l < "${PGBOUNCER_USERLIST}") entries."
fi

# ── 5. systemd service ────────────────────────────────────────────────────────
if [[ ! -f "${SERVICE_SRC}" ]]; then
  echo "ERROR: Service file not found: ${SERVICE_SRC}" >&2
  exit 1
fi
echo "==> Installing systemd service → ${SERVICE_DEST}"
run cp "${SERVICE_SRC}" "${SERVICE_DEST}"
run chmod 644 "${SERVICE_DEST}"
run systemctl daemon-reload
run systemctl enable pgbouncer

# Reload (HUP) if running, else start
if systemctl is-active --quiet pgbouncer 2>/dev/null; then
  echo "==> PgBouncer already running — reloading config"
  run systemctl reload pgbouncer
else
  echo "==> Starting PgBouncer"
  run systemctl start pgbouncer
fi

echo ""
echo "==> [P499] PgBouncer provisioning complete."
echo "    Query clients  → :${PGBOUNCER_LISTEN_PORT} (PgBouncer, transaction mode)"
echo "    LISTEN clients → :${PG_PORT} via PGPORT_DIRECT (direct Postgres, bypass)"
echo ""
echo "    Verify:  psql -h 127.0.0.1 -p ${PGBOUNCER_LISTEN_PORT} -U agenthive pgbouncer -c 'SHOW POOLS'"
echo "    Reload:  sudo systemctl reload pgbouncer"
echo "    Logs:    sudo journalctl -u pgbouncer -f"
