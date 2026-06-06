#!/usr/bin/env bash
# MCP runtime boot-smoke.
#
# Boots the MCP SSE server from the CURRENT checkout on an isolated port and
# confirms it actually SERVES (/health -> 200). Catches runtime construction
# failures that the parse-level gate (check-mcp-bundle.mjs) cannot — e.g. a
# dynamic `await import()` destructuring a member the module no longer exports
# ("X is not a constructor"), which crash-loops agenthive-mcp on restart.
#
# Why this exists: tsconfig.check.json does not cover src/apps/mcp-server, so
# neither tsc nor the parse gate catches import/export API drift. A real boot is
# the only faithful guard. Use this before cutting the live service over to a new
# commit. See memory: mcp-merge-corruption-ci-gap.
#
# Requires the DB env (PGPASSWORD etc.) from /etc/agenthive/env -> run with sudo.
# Usage: sudo bash scripts/smoke-mcp-boot.sh [PORT]   (default 6431)
set -uo pipefail

PORT="${1:-6431}"
ENV_FILE="${AGENTHIVE_ENV_FILE:-/etc/agenthive/env}"

if [ -r "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  echo "✗ cannot read $ENV_FILE (run with sudo)"; exit 2
fi

export MCP_PORT="$PORT"
export MCP_HOST="127.0.0.1"
# Smoke the CURRENT checkout's code+config (env file's PROJECT_ROOT points at the
# live dir; the server resolves AGENTHIVE_PROJECT_ROOT, so pin it to here).
export AGENTHIVE_PROJECT_ROOT="${AGENTHIVE_PROJECT_ROOT:-$(pwd)}"
ERR="$(mktemp)"

echo "[smoke] booting MCP on 127.0.0.1:$PORT from $(pwd) ..."
node --import jiti/register scripts/mcp-sse-server.js >"$ERR" 2>&1 &
PID=$!

cleanup() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; rm -f "$ERR"; }
trap cleanup EXIT

ok=0
for i in $(seq 1 25); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "✗ MCP process exited during boot (runtime construction failure):"
    grep -iE "is not a constructor|already been declared|Error|TypeError|Cannot" "$ERR" | head -8
    exit 1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null)"
  if [ "$code" = "200" ]; then ok=1; echo "✓ MCP booted and served /health 200 after ${i}s"; break; fi
  sleep 1
done

if [ "$ok" = "0" ]; then
  echo "✗ MCP did not serve /health within timeout. Last output:"; tail -8 "$ERR"; exit 1
fi
exit 0
