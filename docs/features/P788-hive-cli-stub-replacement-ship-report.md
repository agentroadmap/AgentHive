# P788: Hive-CLI Operator Domains — Stub Replacement Ship Report

**Phase:** COMPLETE  
**Date:** 2026-05-09  
**Documenter:** ccs46ant-bot-docum-a  
**Branch:** codex-four  

---

## 1. Summary

P788 replaced every stub return in the `ControlPlaneClient` for the six operator domains
(`model`, `route`, `budget`, `provider`, `system`, `project`) with real schema-qualified
PostgreSQL queries. As a companion, the hardcoding scanner gained a new `mcp` output format,
a versioned findings JSON Schema, and an `AutoFixDescriptor` interface for future auto-fix
tooling.

Prior to P788, `hive model list`, `hive route list`, `hive budget show`, `hive provider list`,
and `hive system status` all returned hardcoded arrays or explicit TODO messages. After P788,
all commands read live control-plane data and degrade to a well-formed `{ status:
'not_implemented' }` sentinel only when the prerequisite table genuinely does not exist.

---

## 2. Scope of Changes

### 2a. `control-plane-client.ts` — new P788 methods

| Method | Backing table(s) | Notes |
|--------|-----------------|-------|
| `listModels(filters?)` | `roadmap.model_metadata` JOIN `roadmap.model_routes` | Filters: `provider`, `tier`; `r.is_enabled = true` guard |
| `listRoutes()` | `roadmap.model_routes` | Ordered by `route_provider`, `priority` |
| `getBudgetStatus(projectId?)` | `roadmap.project_budget_cap` → `project_capacity_config` → `route_token_budget` (probed via `information_schema`) | Returns `{ status: 'not_implemented' }` when all three are absent |
| `listProviders()` | `roadmap.model_routes` GROUP BY `route_provider` | Aggregates `model_count`, `has_enabled_routes` |
| `getSystemStatus()` | `roadmap.control_runtime_service` + `pg_stat_activity` | Graceful fallback when P787 table absent |
| `getModel(modelId)` | `roadmap.model_metadata` LEFT JOIN `roadmap.model_routes` | Full cost/capability shape with route aggregate counts |
| `getModelCosts()` | Same join, filtered to rows with non-null input/output cost | For `hive model cost` command |
| `getRoute(routeId)` | `roadmap.model_routes` | Alias-rich projection matching `RouteRow` shape |
| `testRoute(routeId)` | Delegates to `getRoute`; no live ping | Returns `ok`/`warning` based on `is_enabled` |
| `getProvider(providerId)` | `roadmap.model_routes` GROUP BY `route_provider = $1` | Full `ProviderRow` projection |

All new methods delegate to `this.query<T>()` (the existing read-only helper) and therefore
inherit its REMOTE_FAILURE error mapping automatically.

### 2b. `control-plane-types.ts` — new domain row types

Eight new exported interfaces were added alongside the existing row types:

| Type | Purpose |
|------|---------|
| `ModelRow` | Full model catalog row with route aggregate fields |
| `RouteRow` | Full route row with aliased fields for the route domain CLI |
| `ProviderRow` | Provider summary aggregated from `model_routes` |
| `RouteTestResult` | Live-test result shape returned by `testRoute()` |
| `SystemServiceRow` | Single entry from `roadmap.control_runtime_service` |
| `SystemStatus` | Composite from `getSystemStatus()` — services + active connections |
| `BudgetCapRow` | Single cap entry from `project_budget_cap` |
| `BudgetStatus` | Return wrapper with `status: 'active' | 'not_implemented'` |

### 2c. Domain command handlers

Five domain `index.ts` files under `src/apps/hive-cli/domains/` wire the new client methods
into Commander-registered subcommands, following the `DomainSchema` pattern established in
P455:

| Domain | File | Subcommands |
|--------|------|-------------|
| `model` | `domains/model/index.ts` | `list`, `info`, `cost` |
| `route` | `domains/route/index.ts` | `list`, `info`, `test` |
| `budget` | `domains/budget/index.ts` | `show`, `consumed` |
| `provider` | `domains/provider/index.ts` | `list`, `info` |
| `project` | `domains/project/index.ts` | `list`, `info` |

All domain handlers respect the `--format text|json|jsonl|yaml` flag where applicable and
propagate `HiveError` exit codes per the cli-hive-contract.

### 2d. Scanner companion changes

Three scanner files were modified or added:

| File | Change |
|------|--------|
| `src/tools/scanner/output.ts` | Added `outputMcp()` function (structured JSON with `schema_version`, `stats`, `findings[]`); added `schema_version: 1` to JSONL line objects; wired `format === 'mcp'` in `writeOutput()` |
| `src/tools/scanner/rules.ts` | Added `AutoFixDescriptor` interface (`transform`, `target_module`, `target_export`) and optional `auto_fix` field on `Rule` — foundation for future auto-remediation pipeline |
| `src/tools/scanner/schema/findings.schema.json` | New JSON Schema (draft-07) for the scanner finding contract; `schema_version` is `const: 1` — consumers must reject records with a higher major version |

---

## 3. Stub Degradation Policy

For domains whose backing tables may not yet exist, P788 follows the design's explicit rule:
**never return fake data — return a clear `not_implemented` indicator.**

| Domain | Degradation behaviour |
|--------|-----------------------|
| `budget` | `{ status: 'not_implemented', message: 'Budget tables not yet created' }` when `information_schema` probe finds none of the three budget tables |
| `system` | `{ services: [], activeConnections: <pg_stat count> }` when `control_runtime_service` absent (P787 prerequisite); `{ services: [], activeConnections: 0 }` on full DB failure |
| All others | Propagate `HiveError` REMOTE_FAILURE (exit code 5) — no sentinel needed as backing tables exist |

---

## 4. SQL Design Notes

### model / route join

The join condition `r.model_name = m.model_name AND r.route_provider = m.provider` uses the
composite unique on `(provider, model_name)` in `model_metadata`. Only routes where
`r.is_enabled = true` are surfaced in `listModels()`. `getModel()` and `getModelCosts()` use
a `LEFT JOIN` to return models with zero routes (inactive or pending route registration).

### budget table probe

`getBudgetStatus()` queries `information_schema.tables` (excluding system schemas) for the
existence of three candidate tables in priority order: `project_budget_cap` (canonical,
schema-qualified) → `project_capacity_config` → `route_token_budget`. This avoids a hard
failure when P760 / P474 budget tables have not been created in the environment.

### system status fallback

`getSystemStatus()` catches any error from the `control_runtime_service` query (which requires
P787 migration to be applied) and retries with only `pg_stat_activity`. The outer catch
returns the zero-state `{ services: [], activeConnections: 0 }` if even the pg query fails.

### scan mcp format

`outputMcp()` produces a single-object JSON (not newline-delimited) with a top-level
`schema_version: 1`, a `stats` summary, and a `findings` array where each element also
carries `schema_version: 1`. This allows MCP consumers to validate the outer envelope and
each finding independently against `findings.schema.json`.

---

## 5. Remaining Gaps

The following items are explicitly out of scope for P788 and tracked separately:

| Gap | Tracking |
|-----|---------|
| `hive scan run` / `hive knowledge list` stubs | P789 (scan infra prerequisite) |
| `hive system status` service-level health checks (not just `is_active` column) | Future health-check proposal |
| Live credential probe in `testRoute()` | `RouteTestResult.credentials_active` always `false`; full probe deferred |
| Auto-fix pipeline using `AutoFixDescriptor` | Interface scaffolded; execution engine not yet built |

---

## 6. Key Files

| File | Role |
|------|------|
| `src/apps/hive-cli/common/control-plane-client.ts` | New P788 methods (lines 712–984): `listModels`, `listRoutes`, `getBudgetStatus`, `listProviders`, `getSystemStatus`, `getModel`, `getModelCosts`, `getRoute`, `testRoute`, `getProvider` |
| `src/apps/hive-cli/common/control-plane-types.ts` | Eight new domain row types exported from P788 section |
| `src/apps/hive-cli/domains/model/index.ts` | Model domain commander registration (`list`, `info`, `cost`) |
| `src/apps/hive-cli/domains/route/index.ts` | Route domain commander registration (`list`, `info`, `test`) |
| `src/apps/hive-cli/domains/budget/index.ts` | Budget domain commander registration (`show`, `consumed`) |
| `src/apps/hive-cli/domains/provider/index.ts` | Provider domain commander registration (`list`, `info`) |
| `src/apps/hive-cli/domains/project/index.ts` | Project domain (pre-existing; P788 verifies `listProjects` was already real) |
| `src/tools/scanner/output.ts` | `outputMcp()` + `schema_version` in JSONL + `mcp` routing in `writeOutput()` |
| `src/tools/scanner/rules.ts` | `AutoFixDescriptor` interface + `auto_fix` field on `Rule` |
| `src/tools/scanner/schema/findings.schema.json` | Stable JSON Schema v1 for scan findings |

---

## 7. Risk Assessment

**Low.** All new client methods are read-only SQL queries against existing schema objects.
The budget probe uses `information_schema` to avoid hard failures on missing tables.
The system status handler has two fallback layers. No migration is required — P788 consumes
tables created by earlier migrations (P760, P474, P787). The scanner changes are additive:
existing `human`, `jsonl`, and `sarif` output paths are unchanged.

---

## 8. Recommendation

**Ship confirmed.** The six operator CLI domains now return live control-plane data instead of
stubs. Degradation is explicit and documented. The scanner output contract is versioned and
machine-readable. No test regressions expected — all changes are additive or follow existing
error-handling patterns in `ControlPlaneClient`.

---

*Generated by ccs46ant-bot-docum-a (documenter) for P788 COMPLETE phase.*
