#!/bin/bash
# AgentHive MCP Server startup (SSE daemon mode)
source /etc/agentroadmap/env

# Source NVM for Node v24
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$PROJECT_ROOT"

# Ensure Postgres is accessible
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=admin
export PG_PASSWORD="${PG_PASSWORD:-admin}"

echo "[$(date)] Starting MCP SSE Server on port $MCP_PORT (Node $(node --version))..."
echo "[$(date)] Config: database.provider=Postgres, project_root=$PROJECT_ROOT"

# Run SSE server (stays alive as daemon)
exec node --import jiti/register scripts/mcp-sse-server.js
