# MCP Server Runbook (P446)

## Overview

The AgentHive MCP server provides agents and clients access to the workflow system through the Model Context Protocol. This runbook explains how to deploy, restart, verify, and troubleshoot the MCP server.

**MCP Service:** `agenthive-mcp` (systemd)
**Configuration:** Environment variables in `/etc/agenthive/env` or local `.env`
**Entry point:** `scripts/mcp-sse-server.js`
**Port:** 6421 (default, configurable via `MCP_PORT`)
**DB pool:** 20 connections (long-running mode with watchdog)

---

## 1. Deployment

### 1.1 First-time Setup

```bash
# Clone the repository
git clone <gitlab-url> /data/code/AgentHive
cd /data/code/AgentHive

# Install dependencies
npm install

# Configure environment
sudo cp /etc/agenthive/env /etc/agenthive/env.backup
# Edit env as needed (see Environment Variables below)

# Install systemd service
sudo cp scripts/systemd/agenthive-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable agenthive-mcp
```

### 1.2 Environment Variables

Required:
- `PGHOST`: PostgreSQL host (default: 127.0.0.1)
- `PGPORT`: PostgreSQL port (default: 5432)
- `PGDATABASE`: Database name (default: agenthive)
- `PGUSER`: PostgreSQL user
- `PGPASSWORD`: PostgreSQL password (store in ~/.pgpass, not in env)

Optional:
- `MCP_PORT`: HTTP server port (default: 6421)
- `MCP_HOST`: HTTP server bind address (default: 127.0.0.1)
- `MCP_TRANSPORT`: Active transports — "sse" | "http" | "both" (default: "both")
- `DEBUG`: Set to "1" to include error details in responses
- `P843_AUTH_ENFORCE_MCP`: Set to "true" to enforce authentication (default: log-only)

### 1.3 Verify Installation

```bash
# Check service status
sudo systemctl status agenthive-mcp

# Check logs
sudo journalctl -u agenthive-mcp -n 50 -f

# Quick health check (see Health Check section below)
curl http://localhost:6421/health
```

---

## 2. Starting and Stopping

### 2.1 Start the Service

```bash
sudo systemctl start agenthive-mcp

# Verify startup
sleep 2
curl http://localhost:6421/healthz
```

Expected output:
```json
{
  "service": "ok",
  "db": "ok",
  "schema_version": 203,
  "git_revision": "a9b55b4b",
  "project_root": "/data/code/AgentHive",
  "db_host": "127.0.0.1",
  "db_name": "agenthive",
  "schema": "roadmap",
  "started_at": "2026-06-10T15:00:00Z",
  "mcp_protocol_version": "2024-11-05"
}
```

### 2.2 Restart the Service

```bash
sudo systemctl restart agenthive-mcp

# Tail logs during restart to catch startup errors
sudo journalctl -u agenthive-mcp -n 100 -f
```

### 2.3 Stop the Service

```bash
sudo systemctl stop agenthive-mcp

# Verify shutdown (wait ~5 seconds)
sleep 5
curl http://localhost:6421/health  # Should timeout or return 503
```

---

## 3. Health Checks

### 3.1 Service Health (`/health`)

Lightweight readiness check. Returns transport config and session count.

```bash
curl http://localhost:6421/health
```

Response:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "sessions": 2,
  "transport": {
    "active": ["sse", "streamable-http"],
    "config": "both",
    "endpoints": {
      "sse": {
        "connect": "http://localhost:6421/sse",
        "messages": "http://localhost:6421/messages",
        "status": "active"
      },
      "streamable-http": {
        "endpoint": "http://localhost:6421/mcp-streamable",
        "aliases": ["/mcp/streamable", "/streamable"],
        "status": "active"
      }
    },
    "readiness_url": "http://localhost:6421/health",
    "deprecation": {
      "sse_retire_after": "2026-07-01",
      "note": "SSE will be retired after all clients migrate to streamable-http. Set MCP_TRANSPORT=http to opt in early."
    }
  },
  "timestamp": "2026-06-10T15:00:15Z"
}
```

### 3.2 Structured Health (`/healthz`)

Detailed diagnostic health. Separates service, database, and schema health.

```bash
curl http://localhost:6421/healthz
```

Response:
```json
{
  "service": "ok",
  "db": "ok",
  "schema_version": 203,
  "git_revision": "a9b55b4b",
  "project_root": "/data/code/AgentHive",
  "db_host": "127.0.0.1",
  "db_name": "agenthive",
  "schema": "roadmap",
  "started_at": "2026-06-10T15:00:00Z",
  "mcp_protocol_version": "2024-11-05"
}
```

**Field meanings:**
- `service`: HTTP server is responding
- `db`: PostgreSQL is reachable and schema_info exists (3s timeout)
- `schema_version`: Latest schema migration number from `roadmap.schema_info`
- `git_revision`: Short commit hash (helps identify version mismatch from transport errors)
- `db_host`, `db_name`: Connection details (never includes credentials)
- `schema`: Schema name (for multi-tenant verification)

### 3.3 Smoke Test (`POST /smoke`)

Verifies the full MCP call chain: initialize → tools/list → safe tool call.

```bash
curl -X POST http://localhost:6421/smoke -H "Content-Type: application/json"
```

Response:
```json
{
  "steps": [
    { "name": "initialize", "elapsed_ms": 5, "result": "ok" },
    { "name": "tools/list", "elapsed_ms": 12, "result": "ok" },
    { "name": "tools/call:mcp_ops", "elapsed_ms": 8, "result": "ok" }
  ],
  "total_ms": 25
}
```

If a step fails, `result` will be "error" and an `error` field will appear:
```json
{
  "steps": [
    { "name": "initialize", "elapsed_ms": 2, "result": "ok" },
    { "name": "tools/list", "elapsed_ms": 1500, "result": "error", "error": "db_timeout" }
  ],
  "total_ms": 1502
}
```

---

## 4. Reading Structured Errors

All MCP errors follow a consistent structure with request ID for correlation.

### 4.1 Error Response Format

```json
{
  "content": [
    {
      "type": "text",
      "text": "validation_error: Missing required parameter: proposal_id"
    }
  ],
  "isError": true,
  "structuredContent": {
    "code": "validation_error",
    "message": "Missing required parameter: proposal_id",
    "request_id": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-06-10T15:00:15Z"
  }
}
```

### 4.2 Error Codes

- `validation_error`: Malformed input or missing required fields
- `db_error`: Database connectivity or schema issues
- `policy_error`: Authentication or authorization failure
- `internal_error`: Unexpected server error

### 4.3 Correlating Errors to Logs

Every MCP request that returns an error includes a `request_id`. Use this to find the corresponding log entries:

```bash
# Find all logs mentioning the request ID
sudo journalctl -u agenthive-mcp | grep "550e8400-e29b-41d4-a716-446655440000"

# Or search application logs for structured traces
psql -d agenthive -c "SELECT * FROM roadmap.trace_span WHERE attributes @> '{\"request_id\": \"550e8400-e29b-41d4-a716-446655440000\"}' ORDER BY started_at DESC LIMIT 10;"
```

---

## 5. Troubleshooting

### 5.1 Service Won't Start

**Symptom:** `sudo systemctl start agenthive-mcp` fails immediately.

**Steps:**
1. Check logs for the root cause:
   ```bash
   sudo journalctl -u agenthive-mcp -n 50
   ```

2. Common causes:
   - **DB unreachable:** Verify `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`
   - **Port already in use:** Change `MCP_PORT` or kill the process holding port 6421
     ```bash
     sudo lsof -i :6421
     sudo kill -9 <PID>
     ```
   - **Node/bun missing:** Verify `which node` or `which bun`

### 5.2 Health Check Returns `db: error`

**Symptom:** `curl http://localhost:6421/healthz` shows `"db": "error"`.

**Steps:**
1. Check if PostgreSQL is running:
   ```bash
   sudo systemctl status postgresql
   psql -U postgres -c "SELECT version();"
   ```

2. Verify MCP server can reach the DB:
   ```bash
   sudo journalctl -u agenthive-mcp -n 20 | grep -i db
   ```

3. Test connectivity from the host:
   ```bash
   psql -h $PGHOST -U $PGUSER -d agenthive -c "SELECT COUNT(*) FROM roadmap.schema_info;"
   ```

4. If schema_info is missing, rerun migrations:
   ```bash
   npm run migrate
   ```

### 5.3 Schema Version Mismatch

**Symptom:** Agents report "schema version mismatch" in error responses.

**Steps:**
1. Check the deployed schema version:
   ```bash
   curl http://localhost:6421/healthz | jq .schema_version
   ```

2. Check what the code expects:
   ```bash
   grep "schema_version\|SCHEMA_VERSION" src/apps/mcp-server/server.ts
   ```

3. If mismatch, reapply migrations (do not restart without redeploying code):
   ```bash
   cd /data/code/AgentHive
   git pull origin main
   npm run migrate
   sudo systemctl restart agenthive-mcp
   ```

### 5.4 Structured Error Shows Credentials

**Symptom:** Error response contains password or API key.

**This is a security bug.** Immediately:
1. Rotate the exposed credential
2. Report to the security team
3. File a P-issue with the error detail
4. Do NOT commit the credential logs

Details should never include passwords. If you see them:
```bash
# Search logs for the leak
sudo journalctl -u agenthive-mcp | grep -i "password\|secret\|key" | head -5

# Rotate credentials
# (follow AUTH_CREDENTIALS_SETUP.md)
```

### 5.5 Smoke Test Hangs or Times Out

**Symptom:** `curl -X POST http://localhost:6421/smoke` never returns.

**Steps:**
1. Check if the MCP server is listening:
   ```bash
   curl http://localhost:6421/health
   ```

2. If health check also hangs, restart the service:
   ```bash
   sudo systemctl restart agenthive-mcp
   sleep 5
   curl http://localhost:6421/health
   ```

3. If still hanging, check for stuck processes:
   ```bash
   ps aux | grep agenthive-mcp
   ps aux | grep node
   ```

4. Check system resources (disk, memory, CPU):
   ```bash
   df -h /
   free -h
   top -bn1 | head -20
   ```

---

## 6. Escalation Matrix

| Issue | Evidence | Owner | Next Step |
| --- | --- | --- | --- |
| Service won't start | Logs show "EADDRINUSE" or "pool end()" | On-call | Check for lingering processes; restart |
| DB unreachable | `/healthz` shows `"db": "error"` for 5+ min | On-call | Page DBA; check PostgreSQL status |
| Schema version mismatch | `/healthz` git_revision ≠ deployed branch | On-call | Run migrations; restart |
| Credentials leaked in error | Structured error contains password | Security + On-call | Rotate credentials; file P-issue; archive logs |
| Smoke test stuck | `POST /smoke` hangs >30s | On-call | Restart MCP; check system resources |

---

## 7. Transport Compatibility

### 7.1 SSE Transport (Legacy)

**Endpoint:** `http://localhost:6421/sse` (SSE stream) + `http://localhost:6421/messages` (POST)

**Use case:** Desktop IDE integrations (Claude Code, other editors).

**Deprecation:** Will be retired after 2026-07-01. Clients should migrate to Streamable-HTTP.

**Keepalive:** SSE supports server-side keepalive. The server sends a heartbeat every 30 seconds if no data is flowing, so clients should not timeout connections <2 minutes idle.

**Reconnect:** If the SSE connection drops, the client must close the session and open a new one (new HTTP connection to /sse).

### 7.2 Streamable-HTTP Transport (Modern)

**Endpoint:** `http://localhost:6421/mcp-streamable` (also `/mcp/streamable`, `/streamable`)

**Use case:** Modern clients (hermes, agy, new integrations).

**Keepalive:** Not required; Streamable-HTTP is stateless. Each HTTP request/response is independent.

**Reconnect:** Automatic on the next HTTP call; no session state to manage.

**Scalability:** Stateless design allows load-balancing and horizontal scaling.

### 7.3 Direct HTTP POST (`/mcp` and `/api/mcp`)

**Endpoint:** `http://localhost:6421/mcp` or `http://localhost:6421/api/mcp`

**Method:** JSON-RPC 2.0 POST

**Use case:** Smoke tests, internal tooling, single-call diagnostics.

**Example:**
```bash
curl -X POST http://localhost:6421/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

---

## 8. Support and Reporting

If you encounter issues not covered in this runbook:

1. **Collect diagnostics:**
   ```bash
   curl http://localhost:6421/healthz > /tmp/healthz.json
   curl -X POST http://localhost:6421/smoke > /tmp/smoke.json
   sudo journalctl -u agenthive-mcp -n 200 > /tmp/mcp-logs.txt
   ```

2. **File a P-issue:** Include the diagnostics and steps to reproduce.

3. **Escalate:** If the service is down for >5 minutes, page the on-call engineer.

---

## References

- **MCP Protocol:** https://modelcontextprotocol.io/
- **Proposal P446:** MCP Runtime Reliability
- **Related Runbooks:**
  - AUTH_CREDENTIALS_SETUP.md (for credential rotation)
  - key-compromise-runbook.md (if credentials are leaked)
