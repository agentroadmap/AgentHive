#!/bin/bash
# Postgres-liveness watchdog — external recovery guard for the control-plane DB.
#
# WHY THIS EXISTS:
#   The postgres-db container is pinned in /data/postgres/docker-compose.yml to a
#   specific host IP ("10.0.0.77:5432:5432"). When that interface is not yet up at
#   docker-start time (boot ordering, a Tailscale/secondary-IP flap), the port
#   bind fails with "cannot assign requested address" and the container exits.
#   `restart: always` does NOT reliably self-heal this: after the failed restart
#   it can settle into a running-but-unattached state (process up, internal socket
#   works, but NO published host ports and NO docker network) — or simply give up.
#   Observed 2026-06-20: the DB was fully unreachable on 127.0.0.1:5432 for ~12h
#   with the container reporting "Up", silently wedging the ENTIRE platform
#   (orchestrator, MCP, board, A2A all crash-looped on ECONNREFUSED 5432). There
#   was no external guard. This script is that guard.
#
# WHAT IT DOES:
#   Probes 127.0.0.1:5432 (the address every service uses). If it is reachable, do
#   nothing. If it is unreachable, recover via `docker compose up -d` and, if the
#   host port is still not published afterwards, `--force-recreate` (the only
#   reliable fix for the running-but-no-ports state). Data is a bind mount
#   (/data/postgres/data), so recreate is non-destructive.
#
# SAFETY:
#   - Requires TWO consecutive unreachable ticks (FAIL_STATE_FILE) before acting,
#     so a transient blip never triggers a recreate.
#   - Cooldown (COOLDOWN_SECONDS) caps recovery attempts to avoid loops if the
#     failure is upstream (disk full, bad image, IP permanently gone).
#   - Every tick appends one audit line to LOG_FILE.
set -uo pipefail

COMPOSE_FILE="${PG_WATCHDOG_COMPOSE:-/data/postgres/docker-compose.yml}"
COMPOSE_DIR="$(dirname "$COMPOSE_FILE")"
CONTAINER="${PG_WATCHDOG_CONTAINER:-postgres-db}"
PROBE_HOST="${PG_WATCHDOG_HOST:-127.0.0.1}"
PROBE_PORT="${PG_WATCHDOG_PORT:-5432}"
COOLDOWN_SECONDS="${PG_WATCHDOG_COOLDOWN_SECONDS:-300}"
LOG_FILE="${PG_WATCHDOG_LOG:-/var/log/agenthive-postgres-watchdog.log}"
STATE_FILE="${PG_WATCHDOG_STATE:-/run/agenthive-postgres-watchdog.last-recover}"
FAIL_STATE_FILE="${PG_WATCHDOG_FAIL_STATE:-/run/agenthive-postgres-watchdog.consecutive-fail}"

NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
NOW_EPOCH=$(date -u '+%s')
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
log() { echo "[$NOW_ISO] $*" >> "$LOG_FILE"; }

# --- 1. probe TCP 5432 (what every service actually connects to) ---
if timeout 5 bash -c "cat < /dev/null > /dev/tcp/${PROBE_HOST}/${PROBE_PORT}" 2>/dev/null; then
  # reachable — clear the consecutive-fail counter and exit
  [ -f "$FAIL_STATE_FILE" ] && rm -f "$FAIL_STATE_FILE"
  log "OK — ${PROBE_HOST}:${PROBE_PORT} reachable"
  exit 0
fi

# --- 2. unreachable: require two consecutive failures before acting ---
FAILS=0
[ -f "$FAIL_STATE_FILE" ] && FAILS=$(cat "$FAIL_STATE_FILE" 2>/dev/null || echo 0)
[[ "$FAILS" =~ ^[0-9]+$ ]] || FAILS=0
FAILS=$(( FAILS + 1 ))
echo "$FAILS" > "$FAIL_STATE_FILE"
if [ "$FAILS" -lt 2 ]; then
  log "UNREACHABLE (${PROBE_HOST}:${PROBE_PORT}) fail #${FAILS}; waiting for a 2nd consecutive failure before recovering"
  exit 0
fi

# --- 3. cooldown guard ---
LAST_RECOVER=0
[ -f "$STATE_FILE" ] && LAST_RECOVER=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
[[ "$LAST_RECOVER" =~ ^[0-9]+$ ]] || LAST_RECOVER=0
SINCE=$(( NOW_EPOCH - LAST_RECOVER ))
if [ "$LAST_RECOVER" -gt 0 ] && [ "$SINCE" -lt "$COOLDOWN_SECONDS" ]; then
  log "UNREACHABLE (fail #${FAILS}) but in cooldown (last recover ${SINCE}s ago < ${COOLDOWN_SECONDS}s); NOT recovering"
  exit 0
fi

# --- 4. recover ---
echo "$NOW_EPOCH" > "$STATE_FILE"
log "UNREACHABLE (fail #${FAILS}) — recovering via 'docker compose up -d' (${COMPOSE_FILE})"
( cd "$COMPOSE_DIR" && docker compose up -d ) >> "$LOG_FILE" 2>&1

# verify the host port is actually published; if not, force-recreate (fixes the
# running-but-no-ports / unattached-network state that a plain start leaves behind)
sleep 4
if ! docker port "$CONTAINER" 2>/dev/null | grep -q ":${PROBE_PORT}\$" ; then
  log "host port :${PROBE_PORT} still not published after up -d; forcing --force-recreate"
  ( cd "$COMPOSE_DIR" && docker compose up -d --force-recreate ) >> "$LOG_FILE" 2>&1
  sleep 4
fi

# --- 5. confirm outcome ---
if timeout 5 bash -c "cat < /dev/null > /dev/tcp/${PROBE_HOST}/${PROBE_PORT}" 2>/dev/null; then
  rm -f "$FAIL_STATE_FILE"
  log "RECOVERED — ${PROBE_HOST}:${PROBE_PORT} reachable after recovery"
else
  log "RECOVERY FAILED — ${PROBE_HOST}:${PROBE_PORT} still unreachable (likely upstream: IP gone, disk, bad image). Leaving for operator."
fi
exit 0
