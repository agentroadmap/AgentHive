#!/usr/bin/env bash
# P522 validation: hammer the MCP SSE endpoint with 50 short-lived sessions
# and verify the LISTEN-leak fix in state-names.ts holds.
#
# Pre-req: agenthive-mcp service has been restarted to pick up the
# state-names.ts loadInFlight serializer (commit on this branch).
#
# Outputs:
#   - LISTEN count before / after
#   - mcp_proposal action=list latency
#   - simple PASS/FAIL summary keyed off AC4 + AC5
set -euo pipefail

ENV_FILE="${HOME}/.agenthive.env"
if [[ -r "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi
export PGPASSWORD

MCP_URL="${MCP_URL:-http://127.0.0.1:6421}"
SESSIONS="${SESSIONS:-50}"

count_listens() {
  PGPASSWORD="$PGPASSWORD" psql -h "${PGHOST:-127.0.0.1}" -U "${PGUSER:-admin}" \
    -d "${PGDATABASE:-agenthive}" -At -c \
    "SELECT COUNT(*) FROM pg_stat_activity WHERE query = 'LISTEN workflow_templates_changed'"
}

before=$(count_listens)
echo "[p522] LISTEN connections before: $before"

echo "[p522] firing $SESSIONS short SSE sessions ..."
for i in $(seq 1 "$SESSIONS"); do
  curl -sS -N --max-time 1 "$MCP_URL/sse" >/dev/null 2>&1 || true
done

# Settle: pg-pool's release path is async; let it drain.
sleep 3

after=$(count_listens)
echo "[p522] LISTEN connections after:  $after"

# AC-5: mcp_proposal action=list latency
list_payload='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mcp_proposal","arguments":{"action":"list"}}}'
t0=$(date +%s.%N)
status=$(curl -sS -o /tmp/p522-list.out -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -X POST "$MCP_URL/mcp" \
  --data "$list_payload" || echo "000")
t1=$(date +%s.%N)
elapsed=$(awk "BEGIN { printf \"%.3f\", $t1 - $t0 }")
echo "[p522] mcp_proposal action=list http=$status elapsed=${elapsed}s"

ac4_pass=false
ac5_pass=false
[[ "$after" -le "$((before + 1))" ]] && ac4_pass=true
awk -v t="$elapsed" 'BEGIN { exit !(t < 1.0) }' && ac5_pass=true

echo
echo "AC-4 (LISTEN delta ≤ 1):       $($ac4_pass && echo PASS || echo FAIL) (before=$before, after=$after)"
echo "AC-5 (action=list  < 1s):      $($ac5_pass && echo PASS || echo FAIL) (elapsed=${elapsed}s, http=$status)"

$ac4_pass && $ac5_pass
