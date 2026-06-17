#!/bin/bash
# Orchestrator stall-watchdog — external liveness guard for the event-driven
# orchestrator daemon.
#
# WHY THIS EXISTS:
#   The orchestrator's in-process liveness alerter (P765) runs ON the same
#   event loop it is meant to watch. When that loop wedges (a hung
#   promise/DB-op silently freezes dispatch — observed 2026-06-15 quota storm
#   ~13h, and again 2026-06-16 ~5h44m), the in-process watchdog freezes too,
#   so no alert fires and systemd's `Restart=on-failure` never triggers
#   because the process is still alive (just deaf). The only reliable wedge
#   signal is the heartbeat AGE in roadmap_workforce.agent_health for identity
#   'orchestrator', which the loop refreshes every HEARTBEAT_INTERVAL_MS
#   (default 60s). This script is an EXTERNAL process that reads that age and
#   restarts the service if it goes stale.
#
# SAFETY:
#   - Restarts only when the heartbeat is clearly stale (> STALE_SECONDS).
#   - Cooldown (COOLDOWN_SECONDS) caps restarts to avoid loops if the wedge
#     is upstream (e.g. DB down).
#   - If the DB itself is unreachable, it does NOT restart (that is a
#     different failure; restarting the orchestrator would not help and could
#     mask the real problem) — it logs and exits.
#   - Every tick appends one line to LOG_FILE for audit.
set -uo pipefail

# --- config (override via env / /etc/agenthive/watchdog.env) ---
STALE_SECONDS="${ORCH_WATCHDOG_STALE_SECONDS:-360}"     # 6x the 60s heartbeat
COOLDOWN_SECONDS="${ORCH_WATCHDOG_COOLDOWN_SECONDS:-900}" # >= clean boot + first heartbeat
SERVICE="${ORCH_WATCHDOG_SERVICE:-agenthive-orchestrator}"
IDENTITY="${ORCH_WATCHDOG_IDENTITY:-orchestrator}"
LOG_FILE="${ORCH_WATCHDOG_LOG:-/var/log/agenthive-orchestrator-watchdog.log}"
STATE_FILE="${ORCH_WATCHDOG_STATE:-/run/agenthive-orchestrator-watchdog.last-restart}"

# --- DB credentials: reuse the orchestrator's own env, direct port (LISTEN/
#     pooler-agnostic; we only need a plain SELECT) ---
[ -f /etc/agenthive/env ] && . /etc/agenthive/env
[ -f /etc/agenthive/watchdog.env ] && . /etc/agenthive/watchdog.env
export PGPASSWORD="${PGPASSWORD:-}"
PGPORT_CHECK="${PGPORT_DIRECT:-5432}"
PG="psql -h ${PGHOST:-127.0.0.1} -p ${PGPORT_CHECK} -U ${PGUSER:-admin} -d ${PGDATABASE:-agenthive} -tA"

NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
log() { echo "[$NOW_ISO] $*" >> "$LOG_FILE"; }
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

# --- 1. read heartbeat age (seconds); empty/non-numeric => DB unreachable or no row ---
AGE=$($PG -c "SELECT EXTRACT(EPOCH FROM (now()-last_heartbeat_at))::int FROM roadmap_workforce.agent_health WHERE agent_identity='${IDENTITY}';" 2>>"$LOG_FILE")
RC=$?

if [ $RC -ne 0 ]; then
  log "SKIP — DB query failed (rc=$RC); not restarting (DB-unreachable is not an orchestrator wedge)"
  exit 0
fi
if ! [[ "$AGE" =~ ^[0-9]+$ ]]; then
  log "SKIP — no heartbeat row for '${IDENTITY}' (age='$AGE'); not restarting on a single empty read"
  exit 0
fi

# --- 2. dispatch-liveness signal ---
#   Heartbeat-fresh != dispatching. The dispatch loop can wedge while a SEPARATE
#   heartbeat timer keeps refreshing agent_health, so an age-only check gives a
#   false OK — observed 2026-06-17: ~3.5h dispatch stall with heartbeat steady at
#   ~50s the whole time; the watchdog never fired and a human had to restart.
#   Treat as stalled when there is dispatchable work AND nothing is running AND no
#   agent_run has started for DISPATCH_STALE_SECONDS. The RUNNING=0 guard ensures
#   we never kill a fleet of legitimately long-running workers (a busy system has
#   running rows even if no NEW run started recently).
DISPATCH_STALE_SECONDS="${ORCH_WATCHDOG_DISPATCH_STALE_SECONDS:-600}"
DISP=$($PG -F'|' -c "SELECT (SELECT count(*) FROM roadmap_proposal.v_dispatchable_proposal), (SELECT count(*) FROM roadmap_workforce.agent_runs WHERE status='running'), COALESCE((SELECT EXTRACT(EPOCH FROM (now()-max(started_at)))::int FROM roadmap_workforce.agent_runs), 999999);" 2>>"$LOG_FILE")
DISPATCHABLE=$(echo "$DISP" | cut -d'|' -f1)
RUNNING=$(echo "$DISP" | cut -d'|' -f2)
RUN_AGE=$(echo "$DISP" | cut -d'|' -f3)

DISPATCH_STALL=0
if [[ "$DISPATCHABLE" =~ ^[0-9]+$ ]] && [[ "$RUNNING" =~ ^[0-9]+$ ]] && [[ "$RUN_AGE" =~ ^[0-9]+$ ]]; then
  if [ "$DISPATCHABLE" -gt 0 ] && [ "$RUNNING" -eq 0 ] && [ "$RUN_AGE" -gt "$DISPATCH_STALE_SECONDS" ]; then
    DISPATCH_STALL=1
  fi
else
  # Non-numeric => DB read hiccup; fall back to heartbeat-only this tick.
  DISPATCHABLE="?"; RUNNING="?"; RUN_AGE="?"
fi

# --- 3. healthy if heartbeat is fresh AND there is no dispatch stall ---
if [ "$AGE" -le "$STALE_SECONDS" ] && [ "$DISPATCH_STALL" -eq 0 ]; then
  log "OK — heartbeat ${AGE}s; dispatchable=${DISPATCHABLE} running=${RUNNING} last_run=${RUN_AGE}s"
  exit 0
fi

if [ "$DISPATCH_STALL" -eq 1 ]; then
  REASON="DISPATCH STALL — dispatchable=${DISPATCHABLE} running=0 last_run_age=${RUN_AGE}s > ${DISPATCH_STALE_SECONDS}s (heartbeat ${AGE}s, fresh)"
else
  REASON="heartbeat age ${AGE}s > ${STALE_SECONDS}s"
fi

# --- 4. stale: check cooldown ---
LAST_RESTART=0
[ -f "$STATE_FILE" ] && LAST_RESTART=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
NOW_EPOCH=$(date -u '+%s')
SINCE=$(( NOW_EPOCH - LAST_RESTART ))
if [ "$LAST_RESTART" -gt 0 ] && [ "$SINCE" -lt "$COOLDOWN_SECONDS" ]; then
  log "STALE (${REASON}) but in cooldown (last restart ${SINCE}s ago < ${COOLDOWN_SECONDS}s); NOT restarting"
  exit 0
fi

# --- 5. restart ---
log "STALE — ${REASON}; restarting ${SERVICE}"
echo "$NOW_EPOCH" > "$STATE_FILE"
if systemctl restart "$SERVICE" 2>>"$LOG_FILE"; then
  log "RESTART issued for ${SERVICE} (${REASON})"
else
  log "RESTART FAILED for ${SERVICE} (systemctl rc=$?)"
fi
exit 0
