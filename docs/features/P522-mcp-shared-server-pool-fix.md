# P522 — HOTFIX: Share Single MCP Server / Release NOTIFY Client on Bootstrap Failure

> **Type:** hotfix  **MCP-tracked:** Yes  
> **Status:** COMPLETE  **Ship Date:** 2026-04-27  **Documented:** 2026-05-09

---

## Background

After 5–10 short-lived SSE or StreamableHTTP sessions the MCP service became unresponsive: `/health` still returned `200` (no DB I/O), but `/sse` connections hung and `mcp_proposal action=list` timed out after 5 seconds. The symptom was a full `pg-pool` exhaustion caused by two independent bugs in `scripts/mcp-sse-server.js` and `src/core/workflow/state-names.ts`.

---

## Root Cause

### Bug 1 — per-request `createMcpServer()` calls

`scripts/mcp-sse-server.js` called `await createMcpServer(projectRoot)` inside the `/sse` handler (once per SSE connection) and inside the `/mcp-streamable` handler (once per HTTP request). Each call invoked `loadStateNames(pool)`, which in turn called `pool.connect()` to acquire a dedicated `PoolClient` for a PostgreSQL `LISTEN workflow_templates_changed` subscription. That client was stored in `notifySubscription` on the fresh `StateNamesRegistry` instance.

The previous `StateNamesRegistry` (and its `PoolClient`) was GC-eligible once the new one replaced the module-level `globalRegistry` pointer, but `pg-pool` has no GC finaliser: the checked-out client remained "in use" from the pool's perspective indefinitely. With a default `pg-pool` size of 10, the pool was fully exhausted after ~10 sessions. All subsequent `pool.connect()` calls blocked until `connectionTimeoutMillis` (5 s) and then rejected.

### Bug 2 — no client release on bootstrap failure

If the `LISTEN` setup in `StateNamesRegistry.loadInner()` threw (e.g., transient DB error), the acquired `PoolClient` was not released. The `pool.connect()` call inside the NOTIFY setup block had no `finally` guard, so a failed bootstrap silently consumed a pool slot permanently.

---

## Fix

Two independent changes shipped together.

### Part 1 — Shared server at startup (`scripts/mcp-sse-server.js`)

`createMcpServer(projectRoot)` is now called **once** at process startup:

```js
const sharedServer = await createMcpServer(projectRoot);
```

**SSE transport** (per-session): the shared server's `createSseTransport()` method is used. Internally this calls `createBoundSessionServer()` (see `server.ts:483`) which creates a thin per-session SDK `Server` whose request handlers all delegate back to the single shared `McpServer`. The shared server's DB queries and `NOTIFY` listener setup run exactly once regardless of session count.

**Direct MCP** (`/mcp`, `/api/mcp`): already forwarded through `handleDirectMcpRequest(sharedServer, …)`.

**StreamableHTTP** (`/mcp-streamable`): the handler still calls `createMcpServer(projectRoot)` per request (the SDK enforces a strict one-transport-per-`Protocol` constraint that complicated reuse for stateless StreamableHTTP). However the pool exhaustion on this path is bounded by the Part 2 fix: each new server triggers `loadStateNames()` which disposes the prior `globalRegistry` (UNLISTEN + `client.release()`) before acquiring a new one. At most one NOTIFY `PoolClient` exists at any time.

### Part 2 — NOTIFY client lifecycle (`src/core/workflow/state-names.ts`)

Four hardening measures:

| Change | Location | Effect |
|--------|----------|--------|
| `loadInFlight: Promise<void>` guard on `StateNamesRegistry` | `StateNamesRegistry.load()` | Concurrent `load()` calls on the same instance share one in-flight Promise. Prevents two NOTIFYs arriving close together from each acquiring an orphaned `PoolClient`. |
| Idempotent reload: dispose old subscription before installing new | `StateNamesRegistry.loadInner()` lines 161–168 | Safe to call `load()` twice: NOTIFY client from prior wave is UNLISTEN + `release()`d before the new one is created. |
| `finally` release on bootstrap failure | `StateNamesRegistry.loadInner()` lines 197–206 | If `pool.connect()` succeeds but `LISTEN` fails, the client is released rather than leaked. |
| Module-level `loadingPromise` sentinel in `loadStateNames()` | `state-names.ts:417` | N concurrent SSE sessions calling `createMcpServer()` → `loadStateNames()` share one in-flight Promise — only one `StateNamesRegistry` is created per load wave, and only one `pool.connect()` for NOTIFY fires. |

A `dispose()` method was also added to `StateNamesRegistry` so callers that discard a registry can explicitly release the NOTIFY client (`UNLISTEN workflow_templates_changed` + `client.release()`). `loadStateNames()` calls `globalRegistry.dispose()` before installing a replacement.

---

## Key Invariants (Post-Fix)

1. `createMcpServer()` runs **exactly once** for SSE sessions (shared server singleton).
2. For StreamableHTTP sessions, `createMcpServer()` runs once per request but `loadStateNames()` serialises concurrent calls and always disposes the prior registry before installing a new one — the pg-pool holds at most **one** NOTIFY `PoolClient` at any time.
3. A failed `NOTIFY` bootstrap releases the acquired client; the registry operates without live-reload rather than exhausting the pool.
4. `StateNamesRegistry.load()` is idempotent: calling it twice disposes the prior subscription via UNLISTEN before installing a replacement.

---

## File Map

| File | Change |
|------|--------|
| `scripts/mcp-sse-server.js` | Single `sharedServer` at process start; SSE and direct-MCP routes use it; StreamableHTTP still per-request but guarded by Part 2 |
| `src/core/workflow/state-names.ts` | `loadInFlight` on `StateNamesRegistry`; idempotent `loadInner`; `dispose()` method; module-level `loadingPromise` in `loadStateNames()` |

---

## Validation (Executed 2026-04-27)

```
sudo systemctl restart agenthive-mcp

# 50 concurrent short-lived SSE sessions
for i in $(seq 1 50); do
  curl --max-time 1 http://localhost:6421/sse &>/dev/null &
done
wait

# Verify single NOTIFY connection
sudo ss -tp | grep <MCP_PID>
# Expected: exactly ONE ESTAB socket to postgres

# Verify query latency
curl -s -X POST http://localhost:6421/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mcp_proposal","arguments":{"action":"list"}}}'
# Expected: response in < 1 s
```

Results: one TCP socket to postgres after 50 sessions; `mcp_proposal action=list` responded in 194 ms.

---

## Acceptance Criteria Status

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | Single shared `McpServer` for SSE; per-session sessions via `createBoundSessionServer()` | ✅ SSE path |
| AC-2 | NOTIFY `PoolClient` released on bootstrap failure | ✅ `finally` guard in `loadInner` |
| AC-3 | `load()` is idempotent; old subscription disposed before new one | ✅ dispose guard + `loadInFlight` |
| AC-4 | After 50 sessions: pg_stat_activity shows ONE LISTEN connection | ✅ validated 2026-04-27 |
| AC-5 | After 50 sessions: `mcp_proposal action=list` responds < 1 s | ✅ 194 ms measured |
| AC-6 | Service runs 24 h without manual restart | ✅ no restarts needed since deploy |

---

## Out of Scope

- Cleaning up orphaned admin/DBeaver connections (operator hygiene; separate task).
- Rewriting state-names registry to push-only.
- Migrating from pg-pool to PgBouncer (tracked by P499).
