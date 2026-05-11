# P759 — B5: getPool() Rewire — Deferred Pending P820/P745

> **Type:** issue  **Parent:** P745  **MCP-tracked:** Yes  
> **Status:** COMPLETE  **Ship Date:** 2026-05-04  **Documented:** 2026-05-09

---

## Background

P759 targeted the final plumbing step of the hiveCentral/tenant-DB split: auditing every `getPool()` call site in `src/` and `scripts/`, classifying each query as control-plane or project-scoped, and rewiring project-scoped callers to `config.getProjectDb(slug)`.

The proposal was resolved **without executing the rewire**. The summary decision recorded at completion:

> Post-P820 code rewiring work. Do not audit/rewire getPool callers against the old migration model. Wait for reviewed hiveCentral/tenant connection interfaces from P820/P745, then route control-plane and tenant queries accordingly.

---

## Why It Was Deferred

Two upstream proposals must land before B5 rewiring is safe:

| Proposal | Scope | What B5 needs from it |
|----------|-------|-----------------------|
| **P745** (parent) | hiveCentral/tenant DB split architecture | Finalised call-site routing contract — which callers stay on the control pool, which move to `getProjectDb()` |
| **P820** | Reviewed hiveCentral/tenant connection interfaces | Stable `getControlPool()` / `getProjectDb()` API shapes that B5 call sites can import without risk of breaking on the next architecture pass |

Rewiring 60+ call sites before those interfaces are reviewed and locked creates unnecessary rework risk: if the pool API surface changes (signatures, error types, audit semantics) after the rewire, every changed file becomes a double-touch.

---

## Current State (as of 2026-05-04)

### Two parallel pool APIs coexist

| API | File | Status |
|-----|------|--------|
| `getPool()` | `src/infra/postgres/pool.ts` | Legacy singleton. Routes to whatever `PGHOST/PGDATABASE` points at. ~60 active call sites. |
| `getControlPool()` | `src/postgres/pool-registry.ts` | P497 control pool. Singleton with DSN-change detection via `AGENTHIVE_CONTROL_DSN`. |
| `getProjectDb(slug)` | `src/postgres/pool-registry.ts` | P497 tenant pool. LRU-cached, vault-backed, per-project DSN. |

In the current single-DB topology, `getPool()` and `getControlPool()` point to the same physical database (`agenthive`). No query is silently 0-row-ing from misrouting yet because the DB boundary hasn't been physically split.

### P844 access control is live on both surfaces

`src/infra/postgres/pool.ts:query()` denies agent principals (throws `PoolAccessDenied`). `src/postgres/pool-registry.ts:getProjectDb()` performs agent role checks via `control_identity.agent_project_roles` and logs all decisions to `control_identity.pool_access_audit`.

### Call-site count

A grep of `src/` and `scripts/` at completion time found **~60 `getPool()` call sites** across these areas:

| Area | Files | Notes |
|------|-------|-------|
| `src/apps/hive-cli/` | `control-plane-client.ts` (13), domain handlers (9) | All query control-plane tables |
| `src/apps/server/index.ts` | 4 sites | Mixed control-plane queries |
| `src/apps/mcp-server/` | `server.ts` (4), message tools (3) | Control-plane tables |
| `src/apps/discord-bridge/` | `discord-bridge.ts` (4) | Control-plane messaging tables |
| `src/core/` | `state-machine-guards.ts` (3), `gate-scanner-v2.ts` (1), `orchestrator.ts` (1) | Control-plane workflow tables |
| `src/infra/` | `pool.ts` (internal), `proposal-storage-v2.ts` (4), `liaison-message-service.ts` (1) | Control-plane tables |
| `src/apps/dashboard-web/` | `websocket-server.ts` (1) | Control-plane projection |
| `src/shared/runtime/` | `endpoints.ts` (2) | Bootstrap path |
| `src/apps/cli.ts` | 1 site | Control-plane utility |
| `src/postgres/pool-registry.ts` | Internal only | Already uses `getControlPool()` |

Based on a preliminary pass against the P430 table classification, every identifiable query targets **control-plane tables** (`roadmap_proposal`, `roadmap`, `roadmap_workforce`, `roadmap_efficiency`, `control_identity`, `control_runtime`, `control_audit`, `control_git`). No project-scoped data access via `getPool()` was found — confirming the monolithic DB has not yet split.

---

## What Remains for the Actual B5 Work

When P820/P745 deliver reviewed interfaces, the execution steps from the original design remain valid:

1. **Enumerate call sites** — `grep -rn 'getPool()\|query(' src/ scripts/` (current count ~60)
2. **Classify each** against the P430 table register — control-plane stays on `getControlPool()`; any project-scoped queries rewire to `getProjectDb(slug)`
3. **Update imports** — replace `import { getPool } from '../../infra/postgres/pool'` with `import { getControlPool } from '../../postgres/pool-registry'` for control-plane sites
4. **Static cross-pool join check** — grep for queries that join control-plane and project-scoped tables in a single statement (must be zero)
5. **Feature-flag guard** — original design called for a per-call-site routing override flag during soak

The migration is mechanical once the interface contracts are locked. All current call sites are classified as control-plane, so the expected rewire is a uniform `getPool()` → `getControlPool()` substitution with zero project-tenant routing changes needed at this time.

---

## Acceptance Criteria Status

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | Enumerate every `getPool()` / `query()` call site | ✅ Catalogued above (~60 sites) |
| AC-2 | Classify each call site as control-plane or project-scoped | ✅ All current sites classify as control-plane |
| AC-3 | `getPool()` defaults to hiveCentral; `getTenantPool(slug)` for project-scoped | ⏸ Deferred — `getControlPool()` + `getProjectDb()` in pool-registry.ts are the target API; call-site migration blocked on P820/P745 |
| AC-4 | Static check: zero cross-pool joins | ⏸ Not applicable until physical DB split (P745/P432) |
| AC-5 | Pairs with P474 config resolution-order spec | ✅ P474 complete; `config.getProjectDb(slug)` is the resolution path |

---

## Files of Interest

| File | Role |
|------|------|
| `src/infra/postgres/pool.ts` | Legacy `getPool()` — still the primary pool for 60+ call sites |
| `src/postgres/pool-registry.ts` | P497 registry — `getControlPool()` + `getProjectDb()` target API |
| `docs/architecture/control-plane/control-db-boundary.md` | P430 table classification — canonical reference for classifying call sites |

---

## Out of Scope

- Executing the `getPool()` → `getControlPool()` substitution across all call sites (blocked on P820/P745)
- Adding any project-scoped `getProjectDb()` callers (no project tables are queried via `getPool()` in current code)
- Physical database split (P432/P745)
- Vault integration for tenant DSNs beyond the env-var default in pool-registry.ts (P496)
