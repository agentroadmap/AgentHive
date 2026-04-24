#!/bin/bash
# State & maturity change feed — pure SQL, no LLM required
# Checks for changes since last run and delivers to Discord webhook
set -euo pipefail

export PGPASSWORD="${PG_PASSWORD:-}"
PG="psql -h 127.0.0.1 -U xiaomi -d agenthive -t -A"

# Webhook for state/maturity feed (separate channel)
WEBHOOK_URL="${DISCORD_WEBHOOK_STATEFEED:?ERROR: DISCORD_WEBHOOK_STATEFEED not set — add to ~/.hermes/.env}"

# State file to track last check time
STATE_FILE="$HOME/.hermes/cron/output/.state-feed-last"
mkdir -p "$(dirname "$STATE_FILE")"

# Get last check time (default: 35 minutes ago if first run)
if [ -f "$STATE_FILE" ]; then
  LAST_CHECK=$(cat "$STATE_FILE")
else
  LAST_CHECK=$(date -u -d '35 minutes ago' '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%S')
fi

NOW=$(date -u '+%Y-%m-%dT%H:%M:%S')

# --- Proposal state changes ---
STATE_CHANGES=$($PG -F'|' -c "
SELECT display_id || ': ' || status || ' (' || maturity || ') — ' || LEFT(title, 60)
FROM roadmap_proposal.proposal
WHERE modified_at > '$LAST_CHECK'::timestamptz
ORDER BY modified_at DESC
LIMIT 15;
" 2>/dev/null)

# --- Gate decisions ---
GATE_CHANGES=$($PG -F'|' -c "
SELECT g.proposal_id || ': ' || g.from_state || ' → ' || g.to_state || ' [' || g.decision || '] by ' || g.decided_by
FROM roadmap_proposal.gate_decision_log g
WHERE g.created_at > '$LAST_CHECK'::timestamptz
ORDER BY g.created_at DESC
LIMIT 10;
" 2>/dev/null)

# --- Maturity transitions ---
MATURITY_CHANGES=$($PG -F'|' -c "
SELECT p.display_id || ': ' || p.maturity || ' — ' || LEFT(p.title, 60)
FROM roadmap_proposal.proposal p
WHERE p.modified_at > '$LAST_CHECK'::timestamptz
  AND p.maturity IN ('mature', 'new')
ORDER BY p.modified_at DESC
LIMIT 10;
" 2>/dev/null)

# --- Agent runs ---
AGENT_RUNS=$($PG -F'|' -c "
WITH route AS (
  SELECT DISTINCT ON (model_name)
    model_name, route_provider, agent_provider, agent_cli,
    CASE
      WHEN api_key_primary IS NOT NULL THEN 'db:primary'
      WHEN api_key_secondary IS NOT NULL THEN 'db:secondary'
      WHEN api_key_env IS NOT NULL THEN 'env:' || api_key_env
      WHEN api_key_fallback_env IS NOT NULL THEN 'env:' || api_key_fallback_env
      ELSE 'none'
    END AS auth_source
  FROM roadmap.model_routes
  ORDER BY model_name, is_default DESC, priority ASC
)
SELECT
  CASE ar.status
    WHEN 'completed' THEN '✓'
    WHEN 'failed' THEN '✖'
    WHEN 'cancelled' THEN '■'
    ELSE '◒'
  END || ' run-' || ar.id ||
  ' ' || COALESCE(ar.agent_identity, 'agent') ||
  ' proposal=' || COALESCE(p.display_id, ar.proposal_id::text, '-') ||
  ' stage=' || COALESCE(ar.stage, '-') ||
  ' status=' || ar.status ||
  ' model=' || COALESCE(ar.model_used, '-') ||
  ' provider=' || COALESCE(route.route_provider, '-') ||
  '/' || COALESCE(route.agent_provider, '-') ||
  ' cli=' || COALESCE(route.agent_cli, '-') ||
  ' auth=' || COALESCE(route.auth_source, '-') ||
  CASE WHEN ar.duration_ms IS NOT NULL THEN ' duration=' || ar.duration_ms::text || 'ms' ELSE '' END
FROM roadmap_workforce.agent_runs ar
LEFT JOIN roadmap_proposal.proposal p ON p.id = ar.proposal_id
LEFT JOIN route ON route.model_name = ar.model_used
WHERE COALESCE(ar.completed_at, ar.started_at) > '$LAST_CHECK'::timestamptz
ORDER BY COALESCE(ar.completed_at, ar.started_at) DESC
LIMIT 20;
" 2>/dev/null)

# --- Open / active work offers ---
DISPATCHES=$($PG -F'|' -c "
SELECT
  'dispatch-' || sd.id ||
  ' proposal=' || COALESCE(p.display_id, sd.proposal_id::text) ||
  ' agency=' || COALESCE(sd.agent_identity, 'unclaimed') ||
  ' role=' || sd.dispatch_role ||
  ' dispatch=' || sd.dispatch_status ||
  ' offer=' || COALESCE(sd.offer_status, '-') ||
  ' caps=' || COALESCE(NULLIF(sd.required_capabilities::text, '{}'), 'none') ||
  ' worker=' || COALESCE(sd.metadata->>'worker_identity', sd.metadata->>'worktree_hint', '-')
FROM roadmap_workforce.squad_dispatch sd
LEFT JOIN roadmap_proposal.proposal p ON p.id = sd.proposal_id
WHERE sd.assigned_at > '$LAST_CHECK'::timestamptz
   OR (sd.completed_at IS NULL AND (sd.dispatch_status IN ('assigned','active','blocked') OR sd.offer_status IN ('open','claimed','activated')))
ORDER BY COALESCE(sd.completed_at, sd.assigned_at) DESC
LIMIT 20;
" 2>/dev/null)

# --- Registered agencies ---
AGENCIES=$($PG -F'|' -c "
SELECT
  ar.agent_identity ||
  ' type=' || ar.agent_type ||
  ' status=' || ar.status ||
  ' role=' || COALESCE(ar.role, '-') ||
  ' model=' || COALESCE(ar.preferred_model, '-') ||
  ' caps=' || COALESCE(NULLIF(string_agg(ac.capability, ',' ORDER BY ac.capability), ''), 'none')
FROM roadmap_workforce.agent_registry ar
LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
WHERE ar.agent_type = 'agency'
GROUP BY ar.agent_identity, ar.agent_type, ar.status, ar.role, ar.preferred_model
ORDER BY ar.agent_identity
LIMIT 20;
" 2>/dev/null)

# Save checkpoint
echo "$NOW" > "$STATE_FILE"

# --- Build message ---
HAS_CHANGES=false
MSG="**State Feed** — $(date -u '+%H:%M UTC')"

if [ -n "$STATE_CHANGES" ]; then
  HAS_CHANGES=true
  MSG="$MSG

**📝 State Changes**
$STATE_CHANGES"
fi

if [ -n "$GATE_CHANGES" ]; then
  HAS_CHANGES=true
  MSG="$MSG

**🚪 Gate Decisions**
$GATE_CHANGES"
fi

if [ -n "$MATURITY_CHANGES" ]; then
  HAS_CHANGES=true
  MSG="$MSG

**⏫ Maturity**
$MATURITY_CHANGES"
fi

if [ -n "$AGENT_RUNS" ]; then
  HAS_CHANGES=true
  MSG="$MSG

**🤖 Agent Runs**
$AGENT_RUNS"
fi

if [ -n "$DISPATCHES" ]; then
  HAS_CHANGES=true
  MSG="$MSG

**📦 Dispatch**
$DISPATCHES"
fi

if [ -n "$AGENCIES" ]; then
  HAS_CHANGES=true
  MSG="$MSG

**🏢 Agencies**
$AGENCIES"
fi

# Only send if there are changes
if [ "$HAS_CHANGES" = false ]; then
  exit 0
fi

# Send to Discord
CONTENT=$(echo "$MSG" | head -c 1900)
curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$CONTENT" '{content: $c}')" \
  >/dev/null 2>&1 || echo "Webhook delivery failed" >&2
