# Connection Pool Budget — Operator Tuning Guide

**Feature:** P497 — Connection pool registry (`pool-registry.ts`)
**Applies to:** all AgentHive processes using `getControlPool()` or `getProjectDb()`

---

## Budget Formula

```
max_connections_required = POOL_MAX_CONTROL
                         + (AGENTHIVE_TENANT_POOL_LRU_MAX × POOL_MAX_TENANT)
                         + 1  (LISTEN client — direct pg.Client)
```

With defaults:

```
= 10 + (16 × 8) + 1
= 10 + 128 + 1
= 139 connections per process
```

Postgres default `max_connections = 100`. **A single AgentHive process with defaults exceeds that.**
Always tune against your actual `max_connections` — see §Sizing below.

---

## Default Values

| Parameter | Default | Env override |
|---|---|---|
| Control pool max | 10 | — (hardcoded) |
| Tenant pool max | 8 per pool | `pool_max` column in `roadmap.project` |
| LRU cap (tenant pools) | 16 | `AGENTHIVE_TENANT_POOL_LRU_MAX` |
| Idle timeout | 5 min | `idle_ms` column in `roadmap.project` |
| Statement timeout | 30 s | `stmt_timeout_ms` column in `roadmap.project` |
| Connection timeout | 5 s | — (hardcoded) |
| Drain grace | 30 s | — (hardcoded) |
| Retry backoff | 500 → 1 000 → 2 000 → 4 000 → 8 000 → 15 000 ms | — |

---

## Sizing Guide

### Single-process, development

```
# postgres max_connections = 100
AGENTHIVE_TENANT_POOL_LRU_MAX=4   # 10 + (4×8) + 1 = 43 — safe
```

### Multi-process, small fleet (≤5 processes)

```
# postgres max_connections = 200
AGENTHIVE_TENANT_POOL_LRU_MAX=8   # 10 + (8×8) + 1 = 75 per proc
                                   # 5 procs × 75 = 375 — need max_connections ≥ 400
# Or: add PgBouncer (P499) in front
```

### Multi-process with PgBouncer (P499)

When P499 is deployed, PgBouncer sits in front of Postgres. The pool budget applies to
PgBouncer's server pool size (`pool_size` × `max_db_connections`), not to Postgres directly.
Postgres sees only PgBouncer's server connections; per-process client connections are absorbed
by PgBouncer.

Set `PGPORT_DIRECT` so the LISTEN client bypasses PgBouncer (transaction-mode poolers
do not support `LISTEN`):

```env
PGPORT=6432          # PgBouncer
PGPORT_DIRECT=5432   # Direct Postgres (for LISTEN only)
```

---

## Per-tenant Overrides

Override per-tenant pool sizing via the `roadmap.project` table:

```sql
UPDATE roadmap.project
SET pool_max        = 4,   -- fewer connections for low-traffic tenants
    idle_ms         = 120000,  -- 2-min idle timeout
    stmt_timeout_ms = 10000    -- 10-s statement timeout
WHERE slug = 'my-tenant';
-- Trigger pool eviction so the new config takes effect:
SELECT pg_notify('pool_evict', '{"slug":"my-tenant"}');
```

The pool-registry picks up `pool_max`, `idle_ms`, and `stmt_timeout_ms` from
`roadmap.project` when the pool is (re-)created.

---

## P518 hiveControl Cutover

When `hiveControl` becomes a separate Postgres instance (P518), set:

```env
CONTROL_DSN=postgres://user:pass@hivecontrol-db:5432/hivecontrol
```

The control pool detects the DSN change on the next `getControlPool()` call and
drains the old pool asynchronously. No restart required.

---

## Stale Pool Eviction

The LISTEN client subscribes to the `pool_evict` channel. Notify it to immediately
evict a tenant pool (e.g. after DSN rotation):

```sql
SELECT pg_notify('pool_evict', '{"slug":"my-tenant"}');
-- or by project_id:
SELECT pg_notify('pool_evict', '{"project_id":42}');
```

---

## Diagnostics

```typescript
import { poolStats } from "./src/postgres/pool-registry.js";
console.log(poolStats());
// {
//   timestamp: "2026-05-04T12:00:00.000Z",
//   total_active_pools: 3,
//   pools: [
//     { name: "control", source: "control", hits: 1234, misses: 1,
//       active_connections: 2, idle_connections: 8, drain_timeouts: 0, ... },
//     { name: "audio-books", source: "project", hits: 99, misses: 1,
//       active_connections: 0, idle_connections: 3, drain_timeouts: 0, ... },
//   ]
// }
```

- `hits` / `misses` are cumulative since process start (survive pool eviction).
- `drain_timeouts` > 0 means a 30 s drain timeout was hit — investigate long-running queries.
- `active_connections = totalCount - idleCount` (from `pg.Pool`).
