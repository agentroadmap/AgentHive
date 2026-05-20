#!/bin/bash
# P1138 chaos test: simulate a PG disconnect on agenthive-a2a-host.service
# and verify the runtime exits, systemd restarts it, and v_agency_status
# returns to online within the target window.
#
# Usage:
#   sudo scripts/chaos/a2a-pg-disconnect.sh
#
# Requires:
#   - DATABASE_URL set (admin role for pg_terminate_backend)
#   - sudo (systemctl + journalctl)
#   - psql in PATH
#
# Expected outcome:
#   - kill the a2a-host pool's PG backend
#   - a2a-host exits within 5 seconds (pool.on("error") → process.exit(1))
#   - systemd restarts the service within 30 seconds (RestartSec=15)
#   - v_agency_status shows all local agencies back to presence_state='online'
#     within 60 seconds of the kill (re-attach + fn_pulse fires per identity)
#
# Output: PASS / FAIL with timing breakdown.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL must be set"
  exit 2
fi

START_TS=$(date +%s)
LOG_SINCE=$(date '+%Y-%m-%d %H:%M:%S')

echo "[chaos] $(date -Is) — START"
echo "[chaos] target: agenthive-a2a-host.service"
echo

# Step 1: Snapshot pre-state.
echo "[chaos] step 1: snapshot pre-state"
PRE_PID=$(systemctl show agenthive-a2a-host.service -p MainPID --value)
PRE_ACTIVE=$(systemctl is-active agenthive-a2a-host.service)
PRE_PRESENCE=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM roadmap.v_agency_status WHERE presence_state='online'")
echo "    pid=$PRE_PID active=$PRE_ACTIVE online_agencies=$PRE_PRESENCE"
echo

if [ "$PRE_ACTIVE" != "active" ]; then
  echo "[chaos] FAIL: agenthive-a2a-host.service is not active (state=$PRE_ACTIVE)"
  exit 1
fi

# Step 2: Find and terminate the PG backend(s) for this PID.
# agenthive-a2a-host opens multiple connections (pool + dedicated LISTEN clients
# for flag-reload and per-agency a2a_msg). Kill them all.
echo "[chaos] step 2: terminate PG backend(s) for a2a-host"
KILLED=$(psql "$DATABASE_URL" -tA <<SQL
SELECT pg_terminate_backend(pid) || ' ' || application_name
FROM pg_stat_activity
WHERE application_name LIKE 'agenthive-a2a%'
  AND pid <> pg_backend_pid();
SQL
)
echo "    sent SIGTERM to backends:"
echo "$KILLED" | sed 's/^/      /'
echo

# Step 3: Wait for systemd to detect the exit and restart.
# RestartSec=15 + service init ~5s. Total window: 30s.
echo "[chaos] step 3: wait for systemd restart (up to 30s)"
DEADLINE=$((SECONDS + 30))
NEW_PID=""
while [ $SECONDS -lt $DEADLINE ]; do
  NEW_PID=$(systemctl show agenthive-a2a-host.service -p MainPID --value)
  if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$PRE_PID" ] && [ "$NEW_PID" != "0" ]; then
    echo "    new pid=$NEW_PID (was $PRE_PID) after $SECONDS s"
    break
  fi
  sleep 1
done

if [ -z "$NEW_PID" ] || [ "$NEW_PID" = "0" ] || [ "$NEW_PID" = "$PRE_PID" ]; then
  echo "[chaos] FAIL: service did not restart within 30s"
  echo "    journalctl tail:"
  sudo journalctl -u agenthive-a2a-host.service --since "$LOG_SINCE" --no-pager | tail -20
  exit 1
fi

# Step 4: Wait for presence_state to return to online for the pre-disconnect set.
echo "[chaos] step 4: wait for presence re-flip (up to 60s post-restart)"
DEADLINE=$((SECONDS + 60))
while [ $SECONDS -lt $DEADLINE ]; do
  NOW_ONLINE=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM roadmap.v_agency_status WHERE presence_state='online'")
  if [ "$NOW_ONLINE" -ge "$PRE_PRESENCE" ]; then
    echo "    presence restored ($NOW_ONLINE >= $PRE_PRESENCE) after $SECONDS s"
    break
  fi
  sleep 2
done

NOW_ONLINE=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM roadmap.v_agency_status WHERE presence_state='online'")
if [ "$NOW_ONLINE" -lt "$PRE_PRESENCE" ]; then
  echo "[chaos] FAIL: presence count did not recover ($NOW_ONLINE < $PRE_PRESENCE)"
  exit 1
fi

# Step 5: Verify the FATAL log line appears in journalctl.
echo "[chaos] step 5: verify pool-error log line"
if sudo journalctl -u agenthive-a2a-host.service --since "$LOG_SINCE" --no-pager | grep -q "FATAL pool error"; then
  echo "    found 'FATAL pool error' in journal"
else
  echo "[chaos] WARN: 'FATAL pool error' not found in journal — service may have exited via different path"
fi

END_TS=$(date +%s)
TOTAL=$((END_TS - START_TS))
echo
echo "[chaos] PASS — total wall time ${TOTAL}s, restart pid $PRE_PID → $NEW_PID, presence $PRE_PRESENCE → $NOW_ONLINE"
