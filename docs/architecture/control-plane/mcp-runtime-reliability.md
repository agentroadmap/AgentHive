# P446 — MCP Runtime Reliability

> **Type:** issue  **Parent:** P429  **MCP-tracked:** Yes  **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P446

This is a design note paired with MCP proposal P446. The MCP/Postgres record is canonical (CONVENTIONS.md §0); this file is a synced projection of the design context.

## Problem

Proposal workflow depends on MCP, but MCP failures currently surface as opaque transport errors such as `Transport closed`. Operators cannot quickly distinguish service-down, transport incompatibility, database reachability, handler errors, or stale deployment code.

## Proposal

Make MCP health, transport compatibility, and proposal-tool readiness observable and testable.

## Acceptance Criteria

1. MCP exposes a direct smoke-test path for `initialize`, `tools/list`, and `tools/call`.
2. MCP health checks report service health separately from database reachability.
3. Proposal-tool failures return structured errors instead of closing the transport.
4. The deployed service path, git revision, project root, database host, and schema are visible without exposing secrets.
5. A runbook explains how to deploy, restart, and verify MCP before agents depend on it.

## Implementation

### Health Endpoint: GET /healthz

Returns immediate service and database status without waiting for handler initialization.

```bash
curl -s http://127.0.0.1:6421/healthz | jq .
```

**Response fields:**
- `service`: 'ok' (always — service is running)
- `db`: 'ok' or 'error' (lightweight reachability probe)
- `db_error`: error message if db='error' (optional)
- `schema_version`: version from schema_info table or null
- `git_revision`: short commit hash (stale is acceptable)
- `project_root`: working directory path
- `db_host`: database hostname (never full DSN)
- `db_name`: database name
- `schema`: schema name (usually 'roadmap')
- `started_at`: process start timestamp (ISO 8601)
- `mcp_protocol_version`: MCP spec version ('2024-11-05')

**Interpretation:**
- `service='ok', db='ok'`: MCP is healthy
- `service='ok', db='error'`: MCP is running but cannot reach database (check PGHOST, PGPORT, credentials)
- Schema version mismatch between deployment and database indicates stale code or incomplete migration

### Smoke Test Endpoint: POST /smoke

Synchronous test path for initialization, tool listing, and a known-safe tool invocation.

```bash
curl -X POST http://127.0.0.1:6421/smoke \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Response:**
```json
{
  "steps": [
    { "name": "initialize", "elapsed_ms": 10, "result": "ok" },
    { "name": "tools/list", "elapsed_ms": 20, "result": "ok" },
    { "name": "tools/call:mcp_ops", "elapsed_ms": 5, "result": "ok" }
  ],
  "total_ms": 35,
  "error": null
}
```

**Interpretation:**
- All steps 'ok': MCP handler and database are operational
- Any step 'error': Check MCP logs and database connectivity
- High elapsed_ms (>1000ms): Check database query performance or network latency

### Structured Error Envelopes

Tool invocation errors return structured JSON instead of closing the transport.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "content": [{ "type": "text", "text": "validation_error: field required" }],
    "structuredContent": {
      "code": "validation_error",
      "message": "field 'title' is required",
      "request_id": "550e8400-e29b-41d4-a716-446655440000",
      "timestamp": "2026-06-08T12:34:56.789Z"
    }
  }
}
```

**Error codes:**
- `validation_error`: Input validation failure (MCP tool argument schema mismatch)
- `db_error`: Database query or connectivity failure
- `policy_error`: Authentication or authorization violation
- `internal_error`: Unexpected handler exception

**Key guarantees:**
- Transport always stays open (never closes due to handler exception)
- request_id is UUID v4 (can be traced in logs)
- timestamp is ISO 8601 UTC

## Deployment & Verification

### Starting MCP

The MCP server runs as a systemd service (if deployed on the shared host).

```bash
sudo systemctl start agenthive-mcp
```

The service is configured with:
- `WorkingDirectory=/data/code/AgentHive` (for git revision lookup)
- Automatic restart on failure
- Pool watchdog to prevent connection exhaustion

### Verifying Deployment

**1. Check service status:**
```bash
curl -s http://127.0.0.1:6421/health | jq '.transport.endpoints'
```

**2. Check structural health:**
```bash
curl -s http://127.0.0.1:6421/healthz | jq '{service, db, git_revision, schema_version}'
```

Expected output:
```json
{
  "service": "ok",
  "db": "ok",
  "git_revision": "60b6aef1",
  "schema_version": "191"
}
```

**3. Run smoke test:**
```bash
curl -X POST http://127.0.0.1:6421/smoke -H "Content-Type: application/json" -d '{}' | jq '.steps[] | {name, result}'
```

Expected: all steps result='ok' and total_ms <1000ms

### Troubleshooting

| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| /healthz db='error' | Database unreachable | Verify PGHOST, PGPORT, PGDATABASE; check pg_isready |
| /smoke has error step | MCP handler crash or database slow | Check MCP logs: `journalctl -fu agenthive-mcp` |
| schema_version mismatch | Stale deployment | Run `npm run build:web` and restart service |
| git_revision='unknown' | No git working tree | Non-fatal; indicates code path clarity only |
| /healthz timeout | Database or network issue | Increase PG_CONNECTION_TIMEOUT_MS (default 3000ms) |

### Rollback

If the MCP service becomes unstable:

```bash
sudo systemctl stop agenthive-mcp
git revert <commit-sha>
npm run build:web
sudo systemctl start agenthive-mcp
curl -s http://127.0.0.1:6421/healthz | jq .
```

## Dependencies

- P410 Control Database Boundary
