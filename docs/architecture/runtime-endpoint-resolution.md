# Runtime Endpoint Resolution

**P787** — DB-backed endpoint registry for MCP and daemon URL resolution.

---

## Background

Before P787, `getMcpUrl()` and `getDaemonUrl()` in `src/shared/runtime/endpoints.ts`
resolved only from environment variables (`MCP_URL` / `AGENTHIVE_MCP_URL` and
`DAEMON_URL` / `AGENTHIVE_DAEMON_URL`). This meant:

- Endpoint changes required a process restart or env mutation.
- No central registry for service topology; operators had to track URLs out-of-band.
- Stale `TODO(P431)` comments referred to an obsolete proposal; actual ownership
  moved under the P429/P474/P501 control-plane path.

P787 adds `roadmap.control_runtime_service` as a DB-backed fallback, exposes async
resolution helpers, and wires `pg_notify` for live cache invalidation — all without
breaking callers that already provide env overrides.

---

## Resolution Order

```
Async resolution (getMcpUrlAsync / getDaemonUrlAsync)
  1. In-process cache hit → return immediately
  2. Env var check: MCP_URL | AGENTHIVE_MCP_URL  (daemon: DAEMON_URL | AGENTHIVE_DAEMON_URL)
     → hit: cache + return
  3. DB lookup: roadmap.control_runtime_service WHERE service_key = 'mcp' | 'daemon'
               AND lifecycle_status = 'active' LIMIT 1
     → hit: cache + return
  4. throw AgentHiveConfigError

Sync resolution (getMcpUrl / getDaemonUrl) — env-only, legacy callers only
  1. In-process cache hit → return immediately
  2. Env var check (same env names as above)
     → hit: cache + return
  3. throw AgentHiveConfigError
```

**Rule**: env always wins over DB. The DB is a fallback, never an override for
operators who have already set an env var.

---

## DB Schema

**Migration**: `database/migrations/053-p787-control-runtime-service.sql`

```sql
CREATE TABLE IF NOT EXISTS roadmap.control_runtime_service (
  service_key      text PRIMARY KEY,
  url              text NOT NULL CHECK (btrim(url) <> ''),
  description      text,
  lifecycle_status text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'deprecated', 'retired', 'blocked')),
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

Seed rows (inserted `ON CONFLICT DO NOTHING`):

| `service_key` | `url` | `description` |
| :--- | :--- | :--- |
| `mcp` | `http://127.0.0.1:6421/sse` | Default AgentHive MCP SSE endpoint |
| `daemon` | `http://127.0.0.1:6420` | Default AgentHive daemon endpoint |

Key constraints:
- `service_key` is the primary key — one canonical row per service.
- `lifecycle_status = 'active'` is the only status the resolver reads.
- An `AFTER INSERT OR UPDATE OR DELETE` trigger fires `pg_notify('runtime_endpoint_changed', ...)`
  with a JSON payload of `{ service_key, op }` so running processes invalidate their cache
  without polling.

---

## Module API (`src/shared/runtime/endpoints.ts`)

### Async helpers (recommended for new callers)

```typescript
import {
  getMcpUrlAsync,
  getDaemonUrlAsync,
  getControlPlanePortAsync,
} from "src/shared/runtime/endpoints";

// Resolves env → DB → throw
const mcpUrl    = await getMcpUrlAsync();
const daemonUrl = await getDaemonUrlAsync();
const port      = await getControlPlanePortAsync();
```

### Sync helpers (legacy — env-only)

```typescript
import {
  getMcpUrl,
  getDaemonUrl,
  getControlPlanePort,
} from "src/shared/runtime/endpoints";

// Env / cache only; throws if not set
const mcpUrl = getMcpUrl();
```

Use sync helpers only in call paths that cannot `await`. All new callers should use
the async helpers; the sync helpers will not gain DB resolution.

### Cache control

```typescript
import { clearEndpointCache } from "src/shared/runtime/endpoints";

clearEndpointCache(); // resets in-process URL cache (called automatically on pg_notify)
```

### Test injection

```typescript
import { configureEndpointResolverForTests } from "src/shared/runtime/endpoints";

configureEndpointResolverForTests({
  queryFn: mockQuery,          // replaces pgQuery for the DB lookup
  connectListener: mockConnect, // replaces getPool().connect() for LISTEN
});
```

`configureEndpointResolverForTests` resets all caches and the listener state so each
test starts clean. Call it in `beforeEach`; the defaults are restored by passing no
arguments.

---

## pg_notify Cache Invalidation

At first DB-backed resolution the module calls `startEndpointInvalidationListener()`,
which acquires a dedicated connection and issues:

```sql
LISTEN runtime_endpoint_changed;
```

On receipt the in-process cache for both services is cleared (`mcpUrlCache = null`,
`daemonUrlCache = null`). The next call to either async helper re-queries the DB.

**Error behaviour**: if the LISTEN connection drops, `listenerStarted` is reset to
`false` so the next resolution attempt re-acquires a connection. Cache is also cleared
on error, forcing a fresh DB lookup.

---

## Error Class

```typescript
class AgentHiveConfigError extends Error {
  name = "AgentHiveConfigError";
}
```

Thrown when a URL is not resolvable from any source. The error message names all
accepted env vars and the `service_key` that must exist in
`roadmap.control_runtime_service`:

```
MCP URL not configured. Set MCP_URL or AGENTHIVE_MCP_URL or add an active
roadmap.control_runtime_service row for service_key='mcp'.
```

---

## Caller Migration

Callers that previously called the sync `getMcpUrl()` directly should switch to the
async form to gain DB-fallback resolution.

| File | Status |
| :--- | :--- |
| `src/core/identity/agent-registry/registry.ts` | Converted (L23, L303) |
| `src/core/pipeline/pipeline-cron.ts` | Decommissioned (P754) |
| CLI command handlers calling `getMcpUrl()` synchronously | Still use sync form — acceptable while env is always set in CLI context |

---

## Relation to Config Resolver (P474)

`src/shared/runtime/config.ts` is the canonical resolver for all process configuration.
`AGENTHIVE_MCP_URL` and `AGENTHIVE_DAEMON_URL` remain valid `structural` keys in
the config resolver (yaml → env override) and continue to satisfy both the sync and
async endpoint helpers via the env check in step 2 of the resolution order.

`roadmap.control_runtime_service` is a specialised registry for *runtime* service
topology — not a general config store. It is read directly by `endpoints.ts`, bypassing
the config resolver class hierarchy, because:

1. It resolves after a live LISTEN-capable connection is available (async concern).
2. It should not gate process startup (the config resolver is synchronous at level 1–4).
3. It has a dedicated `pg_notify` channel distinct from `runtime_flag_changed`.

See `docs/architecture/config-resolver.md` for the full config resolution hierarchy.

---

## Observability

The table is small (one row per service key) and updated infrequently. Standard
Postgres auditing applies. To inspect current registered endpoints:

```sql
SELECT service_key, url, lifecycle_status, updated_at
FROM roadmap.control_runtime_service
ORDER BY service_key;
```

To update an endpoint and propagate the change to all running processes:

```sql
UPDATE roadmap.control_runtime_service
SET url = 'http://new-host:6421/sse', updated_at = now()
WHERE service_key = 'mcp';
-- The AFTER UPDATE trigger fires pg_notify('runtime_endpoint_changed', ...) automatically.
```

No process restart is required. All processes subscribed to `runtime_endpoint_changed`
will clear their cache and re-query on the next call to `getMcpUrlAsync()`.
