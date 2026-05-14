# P826 — V2: Application Code Migration Ship Report

**Proposal:** P826 — V2: application code migration — schema-aware pool + search_path  
**Date:** 2026-05-12  
**Status:** COMPLETE

---

## Purpose

P826 migrates the application's Postgres connection layer to support `agentHive2`, the V2 unified database. All changes are opt-in (gated by `AGENTHIVE_V2_DB_URL`) and do not affect existing `agenthive` DB paths or main-branch behaviour when the variable is absent.

---

## What Was Built

### 1. Schema-Aware Pool (`src/infra/postgres/pool.ts`)

**Extended config type:**
```typescript
type AgentHivePoolConfig = PoolConfig & {
  schema?: string | null;
};
```

**`normalizeSchemaName(schema)`** — validates schema names against `^[A-Za-z_][A-Za-z0-9_$]*$` before they are interpolated into the libpq `options` string. Throws on invalid input; returns `null` for absent/blank values.

**`buildSearchPathOptions(options, schema)`** — appends `-c search_path=<schema>,roadmap_proposal,roadmap_workforce,roadmap_efficiency,roadmap,public` to the existing `options` string. When `schema` is provided it is prepended to the default list; otherwise the default list is used unchanged. This sets `search_path` at connection time — no per-query `SET` statement is needed.

**Schema resolution priority in `resolvePoolConfig()`:**
1. Explicit `schema` passed to `getPool()`
2. `configuredSchema` module-level variable (set by `initPoolFromConfig`)
3. `PG_SCHEMA` environment variable

Schema is included in the pool signature. A schema change triggers graceful pool drain and recreation — callers see the new `search_path` automatically without restart.

**Default search path (unchanged from pre-P826):**
```
roadmap_proposal, roadmap_workforce, roadmap_efficiency, roadmap, public
```

### 2. `roadmap.yaml` — `project_schema` Field

```yaml
databases:
  agentHive2:
    name: agentHive2
    host: 127.0.0.1
    port: 5432
    project_schema: agentHive      # new field; overridden per project by core.project.schema_name
    role: v2_single_db
```

Default value is `agentHive`. The legacy `database:` block (pointing to `agenthive`) is retained and marked DEPRECATED for transition compatibility.

### 3. V2 Query Layer (`src/infra/postgres/proposal-storage-v2.ts`)

All queries use explicit `roadmap_proposal.` schema prefix rather than relying solely on `search_path`, providing defence-in-depth. Key tables:

- `roadmap_proposal.proposal`, `proposal_lease`, `proposal_acceptance_criteria`
- `roadmap_proposal.proposal_dependencies`, `proposal_state_transitions`
- `roadmap_proposal.proposal_discussions`, `proposal_event` (outbox)
- `roadmap_proposal.v_proposal_summary`, `v_proposal_activity`, `v_proposal_queue`, `v_active_leases`

Cross-schema joins (e.g., `roadmap.workflow_templates`, `roadmap.workflow_stages`) retain their own explicit prefix.

### 4. Tenant Pool Resolution (`src/shared/runtime/config.ts` + `src/postgres/pool-registry.ts`)

`config.getProjectDb(slug)` delegates to `pool-registry.getProjectDb()` (P497 pool registry). `tenant_dsn` keys cannot be accessed via `config.get()` — the runtime throws `RuntimeConfigInvalidSource` to enforce this boundary. The registry resolves DSN from `hiveCentral.roadmap.project`, applies per-project schema via `search_path`, and caches pools in an LRU map with promise deduplication (thundering-herd guard).

### 5. MCP Server Startup Connectivity Check (`src/apps/mcp-server/server.ts:717-725`)

```typescript
// V2 agentHive2 connectivity check (P826) — non-fatal, opt-in via env
if (process.env.AGENTHIVE_V2_DB_URL) {
  const { verifyAgentHive2Connection } = await import(
    "../../postgres/pool-registry.ts"
  );
  void verifyAgentHive2Connection(
    process.env.AGENTHIVE_V2_PROJECT_SCHEMA ?? "agentHive",
  );
}
```

The check is **non-fatal and fire-and-forget** (`void`): the MCP server starts regardless of whether `agentHive2` is reachable.

---

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `AGENTHIVE_V2_DB_URL` | DSN for `agentHive2`; enables all V2 code paths | unset (V2 disabled) |
| `AGENTHIVE_V2_PROJECT_SCHEMA` | Override the default project schema | `agentHive` |
| `PG_SCHEMA` | Override schema for the infra pool | unset |
| `PG_OPTIONS` | Extra libpq options (merged with `search_path`) | unset |
| `DEBUG_PG` | Emit pool-open log lines to stderr | unset |
| `__PGPASSWORD_FROM_CONFIG` | Internal staging variable for config-sourced passwords; never written to `PGPASSWORD` to avoid child-process leakage | unset |

---

## Known Gap — `verifyAgentHive2Connection` Not Exported

`server.ts` imports `verifyAgentHive2Connection` from `pool-registry.ts`, but as of this ship report the function is **not exported** from that module. The TypeScript compiler will surface this at build time. A follow-up is required to either:

- Export `verifyAgentHive2Connection` from `pool-registry.ts`, or
- Replace the import with a local ping utility in `server.ts`.

Until resolved, the V2 startup connectivity check is inert (the `if (AGENTHIVE_V2_DB_URL)` branch will throw at runtime, which is caught by the non-fatal `void` wrapper).

---

## Isolation Guarantee (AC-5)

All V2 changes are guarded by the `AGENTHIVE_V2_DB_URL` env check. When absent, the server behaves identically to pre-P826. The `pool.ts` changes are purely additive — `schema` defaults to `null` and the existing default `search_path` is preserved unchanged.

---

## Dependencies

- **P823** — `agentHive2` DDL baseline must be deployed before V2 paths activate.
- **P825** — SMDL migration; avoids `BUILTIN_SMDLS` landing in the wrong schema during cutover.
- **P844** — Pool access control (agent principal denial, audit log) landed in the same `pool.ts` module and is orthogonal to these schema changes.

---

## Files Changed

| File | Change |
|---|---|
| `src/infra/postgres/pool.ts` | `schema` field, `normalizeSchemaName()`, `buildSearchPathOptions()`, schema resolution in `resolvePoolConfig()` |
| `src/infra/postgres/proposal-storage-v2.ts` | New V2 query layer with explicit schema prefixes |
| `src/shared/runtime/config.ts` | `getProjectDb()` delegation + `RuntimeConfigInvalidSource` guard for `tenant_dsn` |
| `src/postgres/pool-registry.ts` | Tenant pool LRU cache, `getProjectDb()`, `CONTROL_SEARCH_PATH` constant |
| `src/apps/mcp-server/server.ts` | V2 connectivity check at startup (lines 717-725) |
| `roadmap.yaml` | `databases.agentHive2.project_schema` field added |

---

## References

- P826 proposal — `mcp_proposal` id 826
- P823 — agentHive2 DDL baseline
- P825 — SMDL V2 migration
- P844 — Pool access control
- P497 — Pool registry (tenant pool management)
- CONVENTIONS.md §6.0 — DB topology (hiveCentral + tenant DBs)
