#!/bin/bash
# Status report delivery — runs without LLM
# Saves to file + optionally sends to Discord webhook
# Logs failures to syslog (tag: agenthive-report) — does not crash
set -euo pipefail

TAG="agenthive-report"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NOW=$(date -u '+%Y-%m-%dT%H:%M')

# --- Generate report ---
REPORT=$("$SCRIPT_DIR/status-report.sh" 2>&1)
RC=$?
if [ $RC -ne 0 ] || [ -z "$REPORT" ]; then
  logger -t "$TAG" "ERROR: status-report.sh failed (exit $RC)"
  echo "[$NOW] ERROR: report generation failed (exit $RC)" >&2
  exit 1
fi

# --- Save to file ---
OUTDIR="$HOME/.hermes/cron/output"
mkdir -p "$OUTDIR"
echo "$REPORT" > "$OUTDIR/status-$NOW.md"

# --- Discord webhook (2000 char limit) ---
WEBHOOK_URL="https://discord.com/api/webhooks/1495804554997137459/H_p4zoRJEQWoRzabKyz49-Qpmcjwae9tTRKtdm8nnwh4VgUeoB4atTKIRzQMVcW9gJta"
CONTENT=$(echo "$REPORT" | head -c 1900)
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$CONTENT" '{content: $c}')" 2>&1) || true

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "204" ]; then
  logger -t "$TAG" "WARNING: webhook delivery failed (HTTP $HTTP_CODE)"
  echo "[$NOW] WARNING: webhook delivery failed (HTTP $HTTP_CODE)" >&2
  # Do not exit 1 — report was saved, webhook is best-effort
fi

logger -t "$TAG" "OK: report delivered (HTTP $HTTP_CODE, ${#REPORT} chars)"
