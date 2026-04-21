# Report Templates — LLM-Free Pattern

All mechanical reports follow the same architecture: **query → format → deliver**.
No LLM is involved. Pure SQL + bash + curl.

## Pattern

Every report is two files:

1. **`scripts/<name>-report.sh`** — queries Postgres, outputs markdown to stdout
2. **`scripts/<name>-report-deliver.sh`** — runs the report, saves to file, delivers via webhook

### Report Script Template

```bash
#!/bin/bash
# <Report Name> — pure SQL, no LLM required
set -euo pipefail

export PGPASSWORD="***"
PG="psql -h 127.0.0.1 -U xiaomi -d agenthive -t -A"

# 1. Query data (pure SQL)
DATA=$($PG -F'|' -c "SELECT ... FROM ... WHERE ..." 2>/dev/null)

# 2. Format as markdown
NOW=$(date -u '+%Y-%m-%d %H:%M UTC')
REPORT="**<Title> — $NOW**"
# ... build report string ...

echo "$REPORT"
```

### Delivery Script Template

```bash
#!/bin/bash
# <Report Name> delivery — runs without LLM
set -uo pipefail

TAG="agenthive-report"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NOW=$(date -u '+%Y-%m-%dT%H:%M')

REPORT=$("$SCRIPT_DIR/<name>-report.sh" 2>&1) || {
  logger -t "$TAG" "ERROR: <name>-report.sh failed (exit $?)"
  exit 1
}

# Save to file
OUTDIR="$HOME/.hermes/cron/output"
mkdir -p "$OUTDIR"
echo "$REPORT" > "$OUTDIR/<name>-$NOW.md"

# Discord webhook (best-effort, does not crash)
WEBHOOK_URL="https://discord.com/api/webhooks/..."
CONTENT=$(echo "$REPORT" | head -c 1900)
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$CONTENT" '{content: $c}')" 2>&1) || true

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "204" ]; then
  logger -t "$TAG" "WARNING: webhook failed (HTTP $HTTP_CODE)"
fi

logger -t "$TAG" "OK: <name> delivered (HTTP $HTTP_CODE)"
```

## Existing Reports

| Report | Script | Schedule |
|--------|--------|----------|
| Status | `status-report.sh` | Hourly (`0 * * * *`) |

## Planned Reports

| Report | Queries | Purpose |
|--------|---------|---------|
| Dispatch | `squad_dispatch`, `proposal_lease` | Open/claimed offers, stale leases |
| Proposal Changes | `proposal` WHERE modified_at > 1h | What changed since last report |
| Lease Audit | `proposal_lease` WHERE released_at IS NULL | Active leases, duration, staleness |

## Crontab

User crontab (current):
```
0 * * * * /data/code/AgentHive/scripts/status-report-deliver.sh >> ~/.hermes/cron/output/status-cron.log 2>&1
```

System crontab (when ready):
```
# /etc/cron.d/agenthive-reports
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
0 * * * * xiaomi /data/code/AgentHive/scripts/status-report-deliver.sh >> /var/log/agenthive-reports.log 2>&1
```

## Error Handling Rules

1. Report generation failure → syslog ERROR, exit 1
2. Webhook failure → syslog WARNING, do NOT exit 1 (file was saved)
3. Every run → syslog OK entry with HTTP code and char count
4. Check logs: `journalctl -t agenthive-report --since "1h ago"`
