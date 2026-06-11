# MCP Transport Compatibility Guide (P446 AC-9)

## Overview

The AgentHive MCP server supports two transports:
1. **SSE (Server-Sent Events)** — legacy, retiring 2026-07-01
2. **Streamable-HTTP** — modern, stateless, scalable

Both transports provide identical MCP protocol semantics. The difference is in how connections are managed and how keepalive is implemented.

---

## 1. SSE Transport (Legacy)

### 1.1 Connection Model

SSE uses a persistent HTTP connection that the server pushes messages to.

```
Client                                 Server
  |                                      |
  |------ GET /sse ------>               |
  |                        [201 Created]  |
  |<----- SSE stream ------               |
  |      (messages flowing)               |
  |                                      |
  |------ POST /messages (request) ->    |
  |<----- SSE stream (response) ------   |
  |                                      |
  |                        [client closes]|
  |------ (connection closes) ------>    |
```

### 1.2 Keepalive Behavior

**Server-side keepalive:** The MCP server sends a heartbeat message every 30 seconds if no data is flowing. This keeps the connection open through proxies and firewalls.

**Client-side timeout:** Clients should NOT timeout connections that are idle <2 minutes. The 30s heartbeat is sufficient.

**Connection loss:** If the connection drops (network failure, timeout after 2+ minutes idle):
- Client receives EOF or read timeout
- Must create a new SSE session (new GET /sse request)
- Previous session state is discarded

### 1.3 Example: SSE Client

```javascript
// Open SSE stream
const eventSource = new EventSource("http://localhost:6421/sse");

// Listen for messages from the server
eventSource.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);
  console.log("Received:", message);
  
  // Send a request back via POST /messages
  const response = await fetch("http://localhost:6421/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    })
  });
  console.log("Response:", await response.json());
});

eventSource.addEventListener("error", () => {
  console.log("Connection lost, need to reconnect");
  eventSource.close();
  // Create a new session
  location.reload();
});
```

### 1.4 Deprecation Timeline

- **Until 2026-07-01:** SSE is supported (running alongside Streamable-HTTP)
- **After 2026-07-01:** SSE endpoint will return 503 with migration note
- **Migration path:** Clients should switch to Streamable-HTTP before July 1

To opt in to deprecation early (rollback if needed):
```bash
export MCP_TRANSPORT=http  # Disable SSE, enable only Streamable-HTTP
sudo systemctl restart agenthive-mcp
```

---

## 2. Streamable-HTTP Transport (Modern)

### 2.1 Connection Model

Streamable-HTTP uses standard HTTP request/response with streaming. No persistent connection.

```
Client                                 Server
  |                                      |
  |------ POST /mcp-streamable ------>  |
  |     (with JSON-RPC request body)    |
  |                        [200 OK]      |
  |<----- Streaming response -------     |
  |      (application/octet-stream)      |
  |                                      |
  |                        [stream ends]  |
  |                                      |
  |------ GET /mcp-streamable (if SSE) ->|
  |<----- Response (JSON) -------        |
  |                                      |
```

### 2.2 Keepalive Behavior

**Server-side keepalive:** Not needed. Each HTTP request stands alone.

**Client-side timeout:** Use standard HTTP timeouts (30s connection, 60s read). Each request/response is independent.

**Connection loss:** If a request fails (network error, timeout):
- The client simply retries the HTTP request
- No session state to restore
- Automatically load-balanceable

### 2.3 Example: Streamable-HTTP Client

```javascript
// Single request (no persistent connection)
async function callMcp(method, args) {
  const response = await fetch("http://localhost:6421/mcp-streamable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.random(),
      method,
      params: args
    }),
    timeout: 30000 // Standard HTTP timeout
  });
  
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Use it
const tools = await callMcp("tools/list", {});
console.log("Available tools:", tools);

// For streaming/long-running requests, use Server-Sent Events on the same endpoint
const eventSource = new EventSource("http://localhost:6421/mcp-streamable");
// (same as SSE usage above, but on the modern endpoint)
```

### 2.4 Advantages

- **Stateless:** No session tracking; scales horizontally
- **Firewall-friendly:** Standard HTTP (ports 80/443, common proxies)
- **Retry-able:** Failed requests don't lose context
- **Load-balanceable:** Send requests to any instance

---

## 3. Health Checks on Both Transports

### 3.1 Transport Verification

**Check which transports are active:**
```bash
curl http://localhost:6421/health | jq '.transport.active'
```

Output:
```json
["sse", "streamable-http"]
```

To verify both transports work:

**SSE test:**
```bash
curl http://localhost:6421/sse &
# Wait for connection...
sleep 2
curl -X POST http://localhost:6421/messages \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

**Streamable-HTTP test:**
```bash
curl -X POST http://localhost:6421/mcp-streamable \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

**Smoke test (covers both):**
```bash
curl -X POST http://localhost:6421/smoke
```

### 3.2 Structured Errors on Both Transports

Both transports return the same structured error format when a tool call fails.

**Example error (SSE):**
```json
{
  "content": [{"type": "text", "text": "validation_error: Missing proposal_id"}],
  "isError": true,
  "structuredContent": {
    "code": "validation_error",
    "message": "Missing proposal_id",
    "request_id": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-06-10T15:00:15Z"
  }
}
```

**Error (Streamable-HTTP):**
Same structure, different transport layer.

The `request_id` is identical across both transports for the same logical request, enabling log correlation.

---

## 4. Migration Guide: SSE → Streamable-HTTP

### 4.1 For Clients

If you're currently using SSE (`GET /sse` + `POST /messages`):

1. **Identify your client:** Search codebase for `/sse` endpoints
2. **Switch endpoint:** Change `/messages` POST to `/mcp-streamable` POST
3. **Remove session tracking:** No need to track sessionId anymore
4. **Update timeout handling:** Use standard HTTP timeout (30s), not SSE-specific logic
5. **Test:** Run smoke test `POST /smoke` and verify both health endpoints

Before 2026-07-01, both work side-by-side. After 2026-07-01, SSE returns 503.

### 4.2 For Operators

To migrate the MCP server itself:

```bash
# Current state: both transports
curl http://localhost:6421/health | jq '.transport.active'
# Output: ["sse", "streamable-http"]

# Opt-in to HTTP-only (post-migration mode)
export MCP_TRANSPORT=http
sudo systemctl restart agenthive-mcp

# Verify
curl http://localhost:6421/health | jq '.transport.active'
# Output: ["streamable-http"]
curl http://localhost:6421/sse
# Output: 503 {"error": "SSE transport is disabled", ...}

# If you need to roll back:
export MCP_TRANSPORT=both
sudo systemctl restart agenthive-mcp
```

### 4.3 Rollback Path

If Streamable-HTTP has issues and you need to revert to SSE:

```bash
export MCP_TRANSPORT=sse
sudo systemctl restart agenthive-mcp

# Verify
curl http://localhost:6421/health | jq '.transport.active'
# Output: ["sse"]

curl http://localhost:6421/mcp-streamable
# Output: 503 {"error": "StreamableHTTP transport is disabled", ...}
```

---

## 5. Troubleshooting Transport Issues

### 5.1 "SSE connection drops immediately"

**Symptom:** `GET /sse` returns 200 but closes in <1 second.

**Diagnosis:**
```bash
curl -v http://localhost:6421/sse 2>&1 | head -50
```

Look for:
- `< Connection: close` → server is closing the connection
- `< Content-Length: 0` → empty response

**Fix:**
1. Check MCP server logs for errors:
   ```bash
   sudo journalctl -u agenthive-mcp -n 20 | tail -10
   ```

2. Verify MCP server is healthy:
   ```bash
   curl http://localhost:6421/healthz
   ```

3. Restart if needed:
   ```bash
   sudo systemctl restart agenthive-mcp
   sleep 2
   curl -v http://localhost:6421/sse
   ```

### 5.2 "Streamable-HTTP returns 503"

**Symptom:** `POST /mcp-streamable` returns 503 "StreamableHTTP transport is disabled".

**Cause:** The server was started with `MCP_TRANSPORT=sse`.

**Fix:**
```bash
# Check current config
grep MCP_TRANSPORT /etc/agenthive/env

# Should be "http" or "both", not "sse"
# If set to "sse", change it:
export MCP_TRANSPORT=both
sudo systemctl restart agenthive-mcp
```

### 5.3 "Health endpoint works, but /sse and /mcp-streamable both return 503"

**Symptom:** `/health` works, but both transport endpoints return 503.

**Cause:** `MCP_TRANSPORT` is set to an invalid value.

**Fix:**
```bash
# Check value
echo $MCP_TRANSPORT
ps aux | grep mcp-sse-server | grep MCP_TRANSPORT

# Should be "sse", "http", or "both"
# If not set or invalid:
export MCP_TRANSPORT=both
sudo systemctl restart agenthive-mcp
```

### 5.4 "SSE and Streamable-HTTP return different results for the same request"

**This should not happen.** Both transports use the same shared MCP server instance.

**Debug:**
```bash
# SSE test
curl -X POST http://localhost:6421/messages \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' > /tmp/sse.json

# Streamable-HTTP test
curl -X POST http://localhost:6421/mcp-streamable \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' > /tmp/http.json

# Compare
diff /tmp/sse.json /tmp/http.json
```

If different, this is a bug. File a P-issue with the request_id from both responses.

---

## 6. Reference

| Aspect | SSE | Streamable-HTTP |
| --- | --- | --- |
| **Endpoint** | `/sse` (connect) + `/messages` (POST) | `/mcp-streamable` |
| **Connection** | Persistent HTTP stream | Stateless HTTP POST/response |
| **Keepalive** | Server heartbeat every 30s | Not needed (stateless) |
| **Session state** | Tracked (sessionId) | None |
| **Timeout** | Client >2min, Server heartbeat 30s | Standard HTTP (30-60s) |
| **Load-balanceable** | No (session pinned to instance) | Yes (stateless) |
| **Status** | Retiring 2026-07-01 | Recommended |
| **Firewall** | May require HTTP/HTTPS tuning | Standard HTTP (80/443) |

---

## 7. Further Reading

- **MCP Protocol Spec:** https://modelcontextprotocol.io/
- **MCP Runbook:** MCP_RUNBOOK.md (deployment, troubleshooting)
- **Proposal P446:** MCP Runtime Reliability (ACs 7-11)
- **Related:** scripts/mcp-sse-server.js (implementation)
