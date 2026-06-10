#!/usr/bin/env bash
# P1142 AC-5 — chaos test: kill ONE per-agency LISTEN backend and verify the
# a2a-host fail-fast + systemd self-heal cycle.
#
# Expected sequence (executed live 2026-06-10, see journal evidence in the AC):
#   1. pg_terminate_backend on one agenthive-a2a-listen-<agency> backend
#   2. journal: "[liaison-agent:<agency>] LISTEN client error: ..."
#   3. journal: "[a2a-host] FATAL LISTEN client error on <agency> — exiting for systemd restart: ..."
#   4. systemd: Main process exited status=1 → Scheduled restart
#   5. reborn host supersedes its stale liaison sessions (supersede_stale_session)
#   6. journal: "boot complete — N of N agencies online", fresh LISTEN backends
#
# Usage: sudo not required for psql (uses ~/.pgpass admin); journal read needs
#        sudo -n. Exits 0 on PASS, 1 on FAIL.
set -euo pipefail

PSQL=(psql -h 127.0.0.1 -U admin -d agenthive -t -A)
TIMEOUT_S=${TIMEOUT_S:-90}

expected=$("${PSQL[@]}" -c "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'agenthive-a2a-listen-%'")
if [ "$expected" -lt 1 ]; then
  echo "FAIL: no agenthive-a2a-listen-% backends found (a2a-host not running?)" >&2
  exit 1
fi

victim=$("${PSQL[@]}" -c "SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'agenthive-a2a-listen-%' LIMIT 1")
start_ts=$(date +%s)
echo "killing LISTEN backend pid=$victim (of $expected)"
"${PSQL[@]}" -c "SELECT pg_terminate_backend($victim)" >/dev/null

deadline=$((start_ts + TIMEOUT_S))
while [ "$(date +%s)" -lt "$deadline" ]; do
  live=$("${PSQL[@]}" -c "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'agenthive-a2a-listen-%' AND backend_start > to_timestamp($start_ts)" || echo 0)
  if [ "$live" -ge "$expected" ]; then
    elapsed=$(( $(date +%s) - start_ts ))
    echo "PASS: $live fresh LISTEN backends after ${elapsed}s (exit→restart→supersede→reboot cycle complete)"
    if command -v journalctl >/dev/null && sudo -n true 2>/dev/null; then
      sudo -n journalctl -u agenthive-a2a-host.service --since "@${start_ts}" --no-pager \
        | grep -E "FATAL LISTEN client error|Scheduled restart|boot complete" | tail -4
    fi
    exit 0
  fi
  sleep 3
done

echo "FAIL: listeners not re-established within ${TIMEOUT_S}s — check journalctl -u agenthive-a2a-host.service" >&2
exit 1
