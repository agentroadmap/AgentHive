# P595 — hivecentral model schema

**Status:** DRAFT → Review  
**Parent:** P590  
**Blocks:** P530.6 (agents have default route), P530.16 (policy seam evaluates route grants)  
**Coordination:** P603 (dispatch.work_claim), P604 (observability.model_routing_outcome)

---

## Problem

Routing logic is scattered across three places:

1. `roadmap.model_routes` — flat table mixing model metadata with route dispatch config
2. `roadmap.host_model_policy` — TEXT[] allow/forbidden arrays that cannot express per-route nuance
3. Code — agent-spawner.ts contains residual hardcoded provider logic that the DB should own

The result: no single query can answer "for this host and this capability requirement, which routes are available and what do they cost?" The dispatch selector must join multiple tables, apply application-layer policy logic, and fall back to code defaults — creating drift between DB state and actual behavior.

---

## Design

### Primitive: routes, not models

The unit of dispatch selection is a **route**, not a model. A single model (`claude-sonnet-4-6`) can have multiple routes:

| route_name | route_provider | notes |
|---|---|---|
| `claude-sonnet-4-6-anthropic` | anthropic | direct API, disabled on this host |
| `claude-sonnet-4-6-via-nous` | nous | OpenAI-compatible proxy, enabled |

This separation allows different scheduling characteristics (priority, rate limits, fallback) per endpoint without duplicating model metadata.

### Schema: `hivecentral.*`

Four tables in a new `hivecentral` schema — distinct from `roadmap.*` to signal the v2 control-plane boundary:

```
hivecentral.model_capability   8-entry vocabulary (stable set)
hivecentral.model              canonical model catalogue
hivecentral.model_route        dispatch routes (unit of selection)
hivecentral.host_model_policy  explicit (host, route) policy rows
```

Two read-optimized views:

```
hivecentral.v_active_routes    enabled + non-deprecated routes with joined model data
hivecentral.v_route_policy     flattened host policy for single-query evaluation
```

### Capability vocabulary

Eight canonical names enforced by a CHECK constraint on `hivecentral.model.capabilities`:

| name | description |
|---|---|
| `long-context` | Context windows > 32 k tokens |
| `tool-use` | Provider function-calling / tool-use API |
| `vision` | Multimodal image understanding |
| `code-review` | Code analysis, review, and generation |
| `structured-output` | JSON-mode / constrained structured generation |
| `reasoning` | Extended thinking / scratchpad chain-of-thought |
| `streaming` | Incremental streaming token responses |
| `cache-aware` | Provider-side prompt caching with distinct pricing |

The old migrations used underscore-based tokens (`tool_use`, `long_context`). The migration script translates only tokens that have an exact hyphen-based match; unknown tokens are dropped.

### Pricing: dual representation

Both `cost_per_1k_*` and `cost_per_1m_*` columns are kept:

- `cost_per_1k_*` — backward compat with existing spending_log consumers
- `cost_per_1m_*` — canonical going forward; per-million is the industry standard for 2025+ models

AC-2 CHECK constraint requires at least one of `cost_per_1k_input` or `cost_per_1m_input` to be non-NULL. Zero (`0.0`) is valid (free/internal routes). NULL means "pricing unknown."

### Host policy: per-row, not arrays

v1 `roadmap.host_model_policy` used `allowed_providers TEXT[]` and `forbidden_providers TEXT[]`. This cannot express per-route exceptions (e.g., "allow nous in general, but block the high-cost reasoning route").

v2 `hivecentral.host_model_policy` is a relation:

```sql
UNIQUE (host, route_id)
is_allowed BOOLEAN NOT NULL
deny_reason TEXT  -- required when is_allowed = false
```

Every (host, route) pair is explicit. The migration expands v1 arrays into per-route rows using the same evaluation logic as `fn_check_spawn_policy`.

### Fallback chains

`model_route.fallback_route_id` + `fallback_condition` declare a fallback graph:

```
claude-opus-4-7-anthropic  ──rate_limit──►  claude-sonnet-4-6-anthropic
claude-sonnet-4-6-anthropic ──rate_limit──►  claude-haiku-4-5-anthropic
```

The dispatch selector follows this chain declaratively. Application code resolves the chain once and never needs to know the chain structure. `fallback_condition` is validated by CHECK constraint: `rate_limit | error_5xx | context_overflow | cost_threshold | any`.

### Cost snapshots in dispatch.work_claim (AC-5)

When an agent claims work, the dispatcher snapshots the current route pricing into `dispatch.work_claim.cost_snapshot` (JSONB). Shape:

```json
{
  "route_name":              "claude-sonnet-4-6-via-nous",
  "model_name":              "claude-sonnet-4-6",
  "cost_per_1m_input":       1.0,
  "cost_per_1m_output":      2.0,
  "cost_per_1m_cache_write": 1.0,
  "cost_per_1m_cache_hit":   0.1,
  "snapshot_at":             "2026-04-27T12:00:00Z"
}
```

Rationale: route pricing is mutable (providers change prices; we can negotiate better rates). Historical cost reports must not drift when prices change. The snapshot is immutable after insert — `route_id` can go NULL if the route is deleted, but the snapshot persists forever.

### Routing decisions in observability.model_routing_outcome (AC-8)

Every dispatch decision is recorded in `observability.model_routing_outcome`:

- `selection_reason_kind` — deterministic label (queryable without prose parsing):  
  `default | capability_match | cost_optimal | fallback | policy_override | manual`
- `candidate_routes_scored` — JSONB array of all evaluated candidates with scores and disqualification reasons
- `evaluation_policy_id` — reserved FK to the policy snapshot that governed evaluation (P604 defines the table)

This table answers "why was this route chosen?" for any work claim without reading application logs.

---

## Autonomous-agent gotchas

Three failure modes surfaced during design review:

1. **Context-window exhaustion mid-task.** An agent starts on a 32 k route and exceeds context mid-task. The fallback chain (`context_overflow` condition) must point to a larger-context route, not a cheaper-but-smaller one. Seed data seeds `fallback_condition='context_overflow'` chains for Claude routes.

2. **Model deprecation auto-rollforward.** When `model.is_deprecated=true` and `successor_model_id` is set, the selector should automatically substitute the successor route. This avoids hard failures when Anthropic deprecates a model. The selector must read `v_active_routes` (which filters `is_deprecated=false`) and follow `successor_model_id` if the originally requested model is gone.

3. **Credential traceback redaction.** `api_key_env`, `api_key_fallback_env`, and `base_url_env` store env var **names**, not values. Application code resolves values at spawn time. Logging must never surface the resolved secret — only the env var name.

---

## Anti-features (explicit non-goals)

| Anti-feature | Reason |
|---|---|
| Per-call state in model_route | Routing is stateless; in-flight counters belong in the rate-limiter layer |
| Cached grants in host_model_policy | Policy must always query the live table; stale caches cause security drift |
| In-flight counter columns | Race conditions under concurrent dispatch; use external rate-limit infra |
| Capability inheritance from provider | Capabilities are model-specific; inheritance would silently grant capabilities to new models |
| model_availability per-region | Deferred to v2 (federation path); out of scope for P595 |
| Soft-delete on model_route | Hard-delete + cost_snapshot makes soft-delete unnecessary |

---

## Artifact index

| File | Purpose |
|---|---|
| `database/ddl/hivecentral/004-model.sql` | Main DDL: 4 tables, 2 views, indexes, triggers, seeds |
| `database/ddl/hivecentral/005-dispatch-stub.sql` | P603 coordination: `dispatch.work_claim` with `cost_snapshot` JSONB |
| `database/ddl/hivecentral/006-observability-stub.sql` | P604 coordination: `observability.model_routing_outcome` reserved fields |
| `database/migrations/055-hivecentral-from-roadmap.sql` | Idempotent migration from `roadmap.model_routes` + `roadmap.host_model_policy` |

---

## Acceptance criteria

| AC | Artifact | Evidence |
|---|---|---|
| AC-1 | `004-model.sql` | 4 tables + 2 views + seeds defined |
| AC-2 | `004-model.sql:model_route` | `CONSTRAINT route_has_price CHECK (cost_per_1k_input IS NOT NULL OR cost_per_1m_input IS NOT NULL)` |
| AC-3 | `004-model.sql:host_model_policy` | per-row UNIQUE (host, route_id) + deny_requires_reason CHECK |
| AC-4 | `004-model.sql:model_route` | `fallback_route_id BIGINT REFERENCES hivecentral.model_route` + `fallback_condition TEXT` with CHECK |
| AC-5 | `005-dispatch-stub.sql` | `dispatch.work_claim.cost_snapshot JSONB NOT NULL DEFAULT '{}'` |
| AC-6 | `004-model.sql` seeds | 8 capability rows + Claude opus/sonnet/haiku models + 3 routes |
| AC-7 | `055-hivecentral-from-roadmap.sql` | ON CONFLICT DO NOTHING everywhere; orphan DO $$ EXCEPTION block |
| AC-8 | `006-observability-stub.sql` | `selection_reason_kind`, `candidate_routes_scored`, `evaluation_policy_id` columns with CHECK |

---

## Migration notes

The migration (`055`) is a read-only import from `roadmap.*`:

- Step 1 imports distinct model names from `roadmap.model_routes`, deriving `provider` and `family` from model_name prefixes.
- Step 2 imports routes with at least one pricing column; routes missing pricing emit a WARNING.
- Step 3 expands `roadmap.host_model_policy` TEXT[] arrays into per-row policy rows (same resolution logic as `fn_check_spawn_policy`).
- Step 4 runs an orphan gate: raises EXCEPTION if any (host, route) combination is unresolved.

`roadmap.model_routes` and `roadmap.host_model_policy` are **not dropped** by this migration. The cutover from roadmap to hivecentral dispatch happens in P530.6 once P595 is merged.

---

## v2 deferred items

- `model_availability` per-region table (federation path)
- `evaluation_policy_id` FK formalization (P604)
- Full `dispatch.work_claim` schema (P603)
- Capability-driven selector implementation (P530.16)
