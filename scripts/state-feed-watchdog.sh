#!/bin/bash
# State feed watchdog — checks if pg_notify listener is alive,
# catches up on missed changes, restarts if dead.
set -euo pipefail

# Load DB credentials — from env or .env file
if [ -z "${PGPASSWORD:-}" ] && [ -f "$HOME/.hermes/.env" ]; then
  . "$HOME/.hermes/.env"
  export PGPASSWORD PGUSER PGDATABASE DISCORD_WEBHOOK_STATEFEED
fi
PGPASSWORD="${PGPASSWORD:?ERROR: PGPASSWORD not set — source ~/.hermes/.env}"
export PGPASSWORD
PG="psql -h 127.0.0.1 -U ${PGUSER:-xiaomi} -d ${PGDATABASE:-agenthive} -t -A"
WEBHOOK_URL="${DISCORD_WEBHOOK_STATEFEED:?ERROR: DISCORD_WEBHOOK_STATEFEED not set — add to ~/.hermes/.env}"
LISTENER_SCRIPT="/data/code/AgentHive/scripts/state-feed-listener.ts"
STATE_FILE="$HOME/.hermes/cron/output/.state-feed-watchdog"
LOG_FILE="$HOME/.hermes/cron/output/state-feed-watchdog.log"
mkdir -p "$(dirname "$STATE_FILE")"

NOW=$(date -u '+%Y-%m-%dT%H:%M:%S')
echo "[$NOW] watchdog tick" >> "$LOG_FILE"

# --- 1. Check if listener process is alive ---
LISTENER_PID=$(pgrep -f "state-feed-listener.ts" 2>/dev/null || true)
if [ -z "$LISTENER_PID" ]; then
  echo "[$NOW] LISTENER DEAD — restarting" >> "$LOG_FILE"

  # Start listener in background with bun
  cd /data/code/AgentHive
  . "$HOME/.hermes/.env" 2>/dev/null || true
  export PGPASSWORD DISCORD_WEBHOOK_STATEFEED
  nohup bun run "$LISTENER_SCRIPT" >> "$LOG_FILE" 2>&1 &
  LISTENER_PID=$!
  echo "[$NOW] Started new listener PID=$LISTENER_PID" >> "$LOG_FILE"
  
  # Give it time to connect
  sleep 3
fi

# --- 2. Check for missed changes (poll fallback) ---
# Get last check time
if [ -f "$STATE_FILE" ]; then
  LAST_CHECK=$(cat "$STATE_FILE")
else
  LAST_CHECK=$(date -u -d '35 minutes ago' '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%S')
fi

# Query for changes since last check
MISSED=$($PG -F'|' -c "
SELECT display_id || ': ' || status || ' (' || maturity || ') — ' || LEFT(title, 50)
FROM roadmap_proposal.proposal
WHERE modified_at > '$LAST_CHECK'::timestamptz
ORDER BY modified_at DESC LIMIT 10;
" 2>/dev/null)

MISSED_GATES=$($PG -F'|' -c "
SELECT proposal_id || ': ' || from_state || ' → ' || to_state || ' [' || decision || ']'
FROM roadmap_proposal.gate_decision_log
WHERE created_at > '$LAST_CHECK'::timestamptz
ORDER BY created_at DESC LIMIT 5;
" 2>/dev/null)

# Save checkpoint
echo "$NOW" > "$STATE_FILE"

# If there were changes, send them (catch-up)
if [ -n "$MISSED" ] || [ -n "$MISSED_GATES" ]; then
  MSG="**State Feed Catch-up** — $(date -u '+%H:%M UTC')"
  [ -n "$MISSED" ] && MSG="$MSG

**📝 Changes**
$MISSED"
  [ -n "$MISSED_GATES" ] && MSG="$MSG

**🚪 Gates**
$MISSED_GATES"

  CONTENT=$(echo "$MSG" | head -c 1900)
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$CONTENT" '{content: $c}')")

  if [ "$HTTP_CODE" = "204" ]; then
    echo "[$NOW] Catch-up delivered: $(echo "$MISSED" | wc -l) changes" >> "$LOG_FILE"
  else
    echo "[$NOW] Webhook failed: HTTP $HTTP_CODE" >> "$LOG_FILE"
  fi
fi

echo "[$NOW] OK — listener PID=$LISTENER_PID" >> "$LOG_FILE"
