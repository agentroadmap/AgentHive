# P788: hive-cli Operator Domains — Stub Removal Ship Report

**Phase:** COMPLETE  
**Date:** 2026-05-09  
**Documenter:** ccs46ant-bot-docum-a  
**Implementation commit:** `9651cf86` (merged `2b771f19` into main 2026-05-04)

---

## 1. Summary

P788 closed the gap left by P455: six operator-facing hive-cli domains — model, budget, route,
provider, knowledge, and agency — were returning empty arrays, zeroed summaries, or explicit
TODO-stub errors instead of real control-plane data.

The fix has two layers:

**Layer 1 — ControlPlaneClient new methods** (`src/apps/hive-cli/common/control-plane-client.ts`)  
Ten new typed DB methods replace what would have been stub return paths in the domains:
`listModels`, `listRoutes`, `getBudgetStatus`, `listProviders`, `getModel`, `getModelCosts`,
`getRoute`, `testRoute`, `getProvider`, `getSystemStatus`.

**Layer 2 — Domain handler rewiring** (five `src/apps/hive-cli/domains/*/index.ts` files)  
Each affected handler was updated to call the corresponding `ControlPlaneClient` method. Domains
whose backing table is not yet ready (knowledge) return a structured `not_implemented` sentinel
rather than fake data, per the P788 design directive.

---

## 2. Domains Addressed

| Domain | CLI commands affected | Resolution |
|--------|----------------------|------------|
| **model** | `hive model info`, `hive model cost` | `getModel()` + `getModelCosts()` — real joins on `model_metadata` × `model_routes` |
| **budget** | `hive budget show`, `hive budget consumed` | `getBudgetStatus()` — info_schema table probe with graceful `not_implemented` sentinel when tables absent |
| **project** | `hive project status` | Parallel queries: `roadmap_proposal.proposal` COUNT + `roadmap.proposal_lease` active-lease count, with `.catch()` fallback |
| **knowledge** | `hive knowledge list`, `hive knowledge get`, `hive knowledge search` | `{ status: 'not_implemented', message: 'P789 prerequisite not landed' }` — no fake data |
| **agency** | `hive agency info` | Removed hardcoded TODO comment; fetch-all + client-side filter is intentional until single-row `getAgency` lands |
| **route / provider** | `hive route list`, `hive provider list` (via model commands) | `listRoutes()` + `listProviders()` — `roadmap.model_routes` GROUP BY aggregation |

---

## 3. ControlPlaneClient New Methods

All new methods live in the `// ─── P788: New domain methods ───` section of
`src/apps/hive-cli/common/control-plane-client.ts` (line 712+).

| Method | SQL source | Notes |
|--------|-----------|-------|
| `listModels(filters?)` | `model_metadata` JOIN `model_routes` WHERE `is_enabled = true` | Supports `provider` + `tier` filters |
| `listRoutes()` | `roadmap.model_routes` | Ordered by `route_provider, priority` |
| `getBudgetStatus(projectId?)` | info_schema probe → `project_budget_cap` / `project_capacity_config` / `route_token_budget` | Returns `not_implemented` sentinel when no budget table exists |
| `listProviders()` | `model_routes` GROUP BY `route_provider` | Derives `model_count` + `has_enabled_routes` |
| `getModel(modelId)` | `model_metadata` LEFT JOIN `model_routes` | Full rich shape; `route_count`, `enabled_route_count`, `agent_providers[]` |
| `getModelCosts()` | Same join, filtered to rows with non-null cost columns | Used by `hive model cost` |
| `getRoute(routeId)` | `model_routes` WHERE `model_name = $1` | Returns `RouteRow` with NULL-coalesced extended fields |
| `testRoute(routeId)` | Calls `getRoute()` internally | Returns `RouteTestResult`; credential/env check deferred |
| `getProvider(providerId)` | `model_routes` WHERE `route_provider = $1` GROUP BY | Returns `ProviderRow` |
| `getSystemStatus()` | `control_runtime_service` + `pg_stat_activity` | Graceful fallback when `P787` table not yet created |

**New type exports** added to `control-plane-types.ts`:

| Type | Purpose |
|------|---------|
| `ModelRow` | Rich model + route join shape |
| `RouteRow` | Extended route descriptor with NULL-coalesced optional fields |
| `ProviderRow` | Provider summary with route/model counts |
| `RouteTestResult` | Route health check result |
| `SystemServiceRow` | Single entry from `control_runtime_service` |
| `SystemStatus` | Composite of service list + active DB connection count |
| `BudgetCapRow` | Single cap row from any budget table |
| `BudgetStatus` | Union: `active` with caps array, or `not_implemented` sentinel |

---

## 4. Design Decisions

### Budget: graceful table probe

Budget backing tables are not guaranteed to exist (`project_capacity_config`,
`route_token_budget`, `project_budget_cap` are all candidates depending on which P has landed).
`getBudgetStatus()` inspects `information_schema.tables` and tries each table in priority order.
When none exist it returns `{ status: 'not_implemented', message: '…' }` — no error thrown,
no fake zeros.

### Knowledge: intentional not_implemented sentinel

The knowledge domain has no backing table until P789 lands. Rather than returning empty arrays
that operators might mistake for "no records," all three handlers return a structured sentinel.
This matches the P788 design directive: "Do NOT return fake data — return a clear
`not_implemented` indicator."

### Agency info: fetch-all + filter

`listAgencies` returns all agencies (control-plane table has no `project_id` column today).
`handleInfo` does a client-side `.find()` on the result. This is intentional — the TODO comment
that implied otherwise was removed in this PR. A single-row `getAgency()` method will replace
this once the agency table gains a stable unique key.

### System status: P787 guard

`getSystemStatus()` queries `roadmap.control_runtime_service`, which is created by P787. The
method handles the case where that table does not yet exist by catching the error and falling
back to returning an empty services list with only the `pg_stat_activity` connection count.

---

## 5. Key Files

| File | Change |
|------|--------|
| `src/apps/hive-cli/common/control-plane-client.ts` | 10 new DB methods (lines 712–984) |
| `src/apps/hive-cli/common/control-plane-types.ts` | 8 new type/interface exports |
| `src/apps/hive-cli/domains/model/index.ts` | `handleInfo` → `getModel()`; `handleCost` → `getModelCosts()` |
| `src/apps/hive-cli/domains/budget/index.ts` | `handleShow`/`handleConsumed` → `getBudgetStatus()` |
| `src/apps/hive-cli/domains/project/index.ts` | `handleStatus` → parallel proposal + lease COUNT queries |
| `src/apps/hive-cli/domains/knowledge/index.ts` | All three handlers → `not_implemented` sentinel |
| `src/apps/hive-cli/domains/agency/index.ts` | Removed TODO comment; behavior unchanged |

---

## 6. Out-of-Scope (Deferred)

| Item | Reason |
|------|--------|
| `hive scan run` / `hive knowledge *` real data | P789 prerequisite not landed |
| Route credential / env-var validation in `testRoute` | Deferred; current impl checks `is_enabled` only |
| Single-row `getAgency(id)` | Agency table lacks stable unique key today |
| `hive system status` full service graph | `control_runtime_service` populated by P787; P788 reads it if present |

---

## 7. Risk Assessment

**Low.** All changes are additive read-path rewirings — no schema alterations, no mutations,
no removal of existing code paths. The `getBudgetStatus` table probe is the most complex path;
it is guarded by an `information_schema` check that cannot throw for missing tables. The
knowledge sentinel is a no-op replacement that eliminates the risk of operators acting on
fake data. No migration required.

---

## 8. Recommendation

**Ship confirmed.** The stub gap documented in P788's design is closed across all five
implemented domains. The two remaining domains (scan, knowledge) degrade gracefully with
structured sentinels rather than errors. The ControlPlaneClient is now the authoritative
read source for model, route, budget, provider, and system status data.

---

*Generated by ccs46ant-bot-docum-a (documenter) for P788 COMPLETE phase.*
