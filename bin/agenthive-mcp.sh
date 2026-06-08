#!/usr/bin/env bash
#
# agenthive-mcp.sh — call an AgentHive MCP tool over the stateless HTTP/JSON-RPC endpoint.
#
# Why this exists: the Antigravity CLI (agy 1.0.6) connects to the agenthive MCP
# server (it shows up green in `/mcp`) but does NOT inject the connected MCP tools
# into the model's function-calling toolset — even Claude Sonnet 4.6 falls back to
# curl. So the antigravity liaison and its workers reach AgentHive through THIS
# wrapper instead of native MCP tool calls. (See ANTIGRAVITY_REGISTRATION.md §4b.)
#
# Usage:
#   agenthive-mcp.sh <tool_name> '<json_arguments>'
#
# Examples:
#   agenthive-mcp.sh mcp_proposal '{"action":"list","limit":3}'
#   agenthive-mcp.sh mcp_message  '{"action":"send","to":"claude-bot-gary.a","text":"hi"}'
#
# Output: the tool's result payload (raw JSON string), printed to stdout. Pipe to
# `jq` to extract fields. Non-zero exit + stderr message on a JSON-RPC error.
#
# Env:
#   AGENTHIVE_MCP_URL   override endpoint (default http://127.0.0.1:6421/mcp)
#
set -euo pipefail

ENDPOINT="${AGENTHIVE_MCP_URL:-http://127.0.0.1:6421/mcp}"
TOOL="${1:?usage: agenthive-mcp.sh <tool_name> '<json_args>'}"
ARGS="${2-}"
[ -n "$ARGS" ] || ARGS='{}'

# Validate the args are well-formed JSON before sending.
if ! printf '%s' "$ARGS" | jq -e . >/dev/null 2>&1; then
  echo "agenthive-mcp: arguments are not valid JSON: $ARGS" >&2
  exit 2
fi

REQ=$(jq -cn --arg name "$TOOL" --argjson args "$ARGS" \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$name,arguments:$args}}')

RESP=$(curl -sS --max-time 120 -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$REQ") || { echo "agenthive-mcp: curl failed against $ENDPOINT" >&2; exit 1; }

# The endpoint may answer as plain JSON or as SSE framing (`data: {...}`). Normalize.
JSON=$(printf '%s' "$RESP" | sed -n 's/^data: //p')
[ -n "$JSON" ] || JSON="$RESP"

ERR=$(printf '%s' "$JSON" | jq -r '.error.message // empty' 2>/dev/null || true)
if [ -n "$ERR" ]; then
  echo "agenthive-mcp: MCP error: $ERR" >&2
  exit 1
fi

# .result.content[0].text holds the tool's own JSON payload as a string; emit it raw.
# Fall back to the whole result object if the shape differs.
printf '%s' "$JSON" | jq -r '.result.content[0].text // (.result | tojson) // empty'
