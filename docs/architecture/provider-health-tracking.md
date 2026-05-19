# Provider Health Tracking — Async Query Endpoint

**P796** — Real-time provider availability checks via `/provider_health` MCP tool.

---

## Design Principles

- **Non-blocking dispatch**: health state is a soft-sort signal, not a hard gate. Dispatch still succeeds when all providers are degraded.
- **2 s SLA**: the MCP tool always returns within 2 s — it reads from an in-memory cache or a single DB row, never waits on a live HTTP probe.
- **Background probing**: `HealthChecker` runs probes on an independent `setInterval`; tool handlers are fully decoupled from the probe loop.
- **Always 200 OK**: on timeout or cache miss the tool returns `{ status: "unknown", stale: true }` — never an error status code.

---

## Architecture

### Two-Layer Cache

```
MCP tool call
     │
     ▼
 HealthCache (in-memory TTL map, default 30 s)
     │  hit: return immediately
     │  miss ──────────────────────────────────┐
     ▼                                         │
 roadmap.provider_health_log (Postgres)        │
     │  latest row for provider+model          │
     │  → stale: true flag set on response     │
     └─────────────────────────────────────────┘
                                               ▲
                                    HealthChecker (background)
                                       ├─ loads routes from model_routes
                                       ├─ probes each with 500 ms timeout
                                       ├─ writes to provider_health_log
                                       └─ updates HealthCache
```

---

## Files

| File | Role |
| :--- | :--- |
| `database/migrations/052-provider-health-log.sql` | Append-log table + indexes |
| `src/core/provider-health/cache.ts` | In-memory TTL cache |
| `src/core/provider-health/checker.ts` | Background probe loop + DB writer |
| `src/apps/mcp-server/tools/provider/health.ts` | MCP tool handler + registration |

---

## DB Schema

```sql
-- database/migrations/052-provider-health-log.sql
CREATE TABLE roadmap.provider_health_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_provider text        NOT NULL,
  model_name     text,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  latency_ms     integer,
  status         text        NOT NULL CHECK (status IN ('ok', 'timeout', 'error')),
  http_status    smallint,
  error_detail   text
);

-- Two covering indexes for the cache-miss fallback query
CREATE INDEX idx_provider_health_log_provider_checked
    ON roadmap.provider_health_log (route_provider, checked_at DESC);

CREATE INDEX idx_provider_health_log_provider_model_checked
    ON roadmap.provider_health_log (route_provider, model_name, checked_at DESC);
```

Rows are append-only. The table is a time-series log; retention/pruning is out of scope for P796.

---

## HealthCache (`src/core/provider-health/cache.ts`)

```typescript
export type HealthStatus = "ok" | "timeout" | "error";

export interface HealthEntry {
  status: HealthStatus;
  checkedAt: number;   // Date.now() epoch ms
  latencyMs?: number;
}

export const DEFAULT_PROVIDER_HEALTH_TTL_MS = 30_000;
```

**Cache key**: `"${provider}:${model || '*'}"` — model defaults to `*` when absent, enabling provider-level lookups that fall back gracefully from specific model queries.

**`HealthCache` class**:
- `get(provider, model?)` — returns `null` on miss or stale entry; checks specific key then provider-wildcard key.
- `set(provider, model, entry)` — stores under the canonical key.
- `clear()` — used in tests; not called in production.

**Module-level singletons** (`getCached`, `setCached`, `clearCachedProviderHealth`) wrap a default `HealthCache` instance so callers don't import the class directly.

**Clock injection**: constructor accepts an optional `now: () => number` for deterministic tests.

---

## HealthChecker (`src/core/provider-health/checker.ts`)

```typescript
export const DEFAULT_CHECK_INTERVAL_MS = 30_000;
export const DEFAULT_PROBE_TIMEOUT_MS  = 500;
```

**Lifecycle**:

```typescript
// Start singleton at process boot (idempotent)
startProviderHealthCheckerOnce();

// Internal timer
start()  → immediate runOnce() + setInterval(runOnce, 30 s); timer.unref()
stop()   → clearInterval
```

`timer.unref()` prevents the background timer from blocking process exit.

**`runOnce()`**:
1. Guard: `this.running = true` — skips cycle if prior one is still in flight.
2. `loadRoutes()` — `SELECT route_provider, model_name, base_url, api_spec FROM roadmap.model_routes WHERE is_enabled = true`.
3. `Promise.allSettled(routes.map(checkRoute))` — all routes probed concurrently.
4. Each `checkRoute()`:
   - Calls `probe(route, 500 ms)` with a catch that converts thrown errors to `{ status: "error" }`.
   - Updates `HealthCache` via `setCached()`.
   - Appends a row to `provider_health_log`.

**Default probe (`defaultProbe`)**:
- Requires `route.baseUrl`; returns `{ status: "error" }` if absent.
- Issues `HEAD {baseUrl}/models` with `AbortSignal.timeout(500)`.
- Maps `TimeoutError` or elapsed ≥ timeout → `status: "timeout"`; non-2xx response → `status: "error"`.

**Dependency injection**: `CheckerOptions` accepts `query`, `probe`, `checkIntervalMs`, `probeTimeoutMs`, `now`, and `onError` overrides — full testability without mocking globals.

---

## MCP Tool (`src/apps/mcp-server/tools/provider/health.ts`)

**Tool name**: `provider_health`

**Inputs**:

| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `provider` | string | no | `route_provider` to inspect |
| `model` | string | no | `model_name` to inspect |

**Response shape** (`ProviderHealthResponse`):

| Field | Type | Notes |
| :--- | :--- | :--- |
| `status` | `"ok" \| "timeout" \| "error" \| "unknown"` | `"unknown"` when no data exists |
| `latencyMs` | number? | Last probe latency |
| `stale` | `true`? | Set when data came from DB fallback or no data exists |
| `checkedAt` | string? | ISO 8601 timestamp of last probe |

**Resolution order**:
1. In-memory cache hit → return immediately, no `stale` flag.
2. DB fallback (`ORDER BY checked_at DESC LIMIT 1`) → return with `stale: true`.
3. No rows → `{ status: "unknown", stale: true }`.

If `provider` is omitted, cache lookup is skipped and the DB query has no `WHERE` predicate (returns most-recent log row across all providers).

**Registration**:

```typescript
// src/apps/mcp-server/tools/provider/health.ts
export function registerProviderTools(server: McpServer): void { … }
```

> **Note**: As of the P796 merge, `registerProviderTools` must be called from `McpServer` constructor in `src/apps/mcp-server/server.ts`. If the tool does not appear in the tool list, verify this call is present.

---

## Route Resolver Integration

`resolveModelRoute()` (P771 scope) uses health status as a soft-sort signal after filtering layers:

- Routes with `status: "error"` or `status: "timeout"` are moved to the **end** of the candidate list.
- They are **not excluded** — dispatch still succeeds when all providers are degraded.
- Routes with `status: "ok"` or `status: "unknown"` (no data yet) rank above degraded routes.

---

## Observability

The `HealthChecker` exposes no metrics object in P796; `provider_health_log` is the primary observable artifact. Derive check rate, timeout rate, and latency percentiles from it:

```sql
-- Recent probe summary (last 10 minutes)
SELECT
  route_provider,
  model_name,
  COUNT(*)                                          AS checks,
  COUNT(*) FILTER (WHERE status = 'timeout')        AS timeouts,
  ROUND(AVG(latency_ms))                            AS avg_latency_ms,
  MAX(checked_at)                                   AS last_checked
FROM roadmap.provider_health_log
WHERE checked_at > now() - INTERVAL '10 minutes'
GROUP BY route_provider, model_name
ORDER BY route_provider, model_name;
```

---

## Configuration

| Setting | Default | Override |
| :--- | :--- | :--- |
| Check interval | 30 000 ms | `CheckerOptions.checkIntervalMs` |
| Probe timeout | 500 ms | `CheckerOptions.probeTimeoutMs` |
| Cache TTL | 30 000 ms | `HealthCache` constructor `ttlMs` |

All three are wired at process boot via `startProviderHealthCheckerOnce(options)`. There is no runtime-reconfigurable flag in P796; a process restart is required to change these values.

---

## Error Boundary (server.ts AC-5/AC-26)

`server.ts` wraps every tool handler in a `try/catch` that converts thrown errors to structured `isError: true` MCP responses, preventing unhandled rejections from crashing the SSE transport. The `provider_health` tool is covered by this boundary.

---

## Acceptance Criteria Mapping

| AC | Behaviour | Where |
| :--- | :--- | :--- |
| Queryable per provider+model | `provider` + `model` inputs on `provider_health` tool | `health.ts` |
| Configurable check interval (30 s default) | `DEFAULT_CHECK_INTERVAL_MS = 30_000` | `checker.ts` |
| 500 ms probe timeout | `DEFAULT_PROBE_TIMEOUT_MS = 500` | `checker.ts` |
| 2 s SLA — never blocks dispatch | Cache/DB read path; checker runs out-of-band | `health.ts`, `checker.ts` |
| 200 OK on timeout | `{ status: "unknown", stale: true }` | `health.ts:107` |
| Observability | `provider_health_log` append table + indexes | migration 052 |
