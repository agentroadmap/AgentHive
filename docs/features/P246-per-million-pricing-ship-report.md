# P246 Ship Report — Per-Million Pricing + Cache Cost Columns

**Status:** COMPLETE  
**Date:** 2026-05-09  
**Proposal:** P246 — Per-million pricing + cache read/write cost columns in `model_metadata` and `model_routes`

---

## What Was Shipped

Four pricing columns added to both `roadmap.model_metadata` and `roadmap.model_routes`:

| Column | Type | Purpose |
|--------|------|---------|
| `cost_per_million_input` | `numeric(12,6)` | Input token cost per 1M tokens |
| `cost_per_million_output` | `numeric(12,6)` | Output token cost per 1M tokens |
| `cost_per_million_cache_write` | `numeric(12,6)` | Cache write cost per 1M tokens |
| `cost_per_million_cache_hit` | `numeric(12,6)` | Cache read (hit) cost per 1M tokens |

Migrations shipped as two idempotent files in `database/ddl/v4/`:

- **005_add_cost_per_million_columns.sql** — DDL: `ADD COLUMN IF NOT EXISTS` + CHECK constraints
- **006_backfill_cost_per_million_prices.sql** — Data: Anthropic canonical prices + non-Anthropic mechanical lift

---

## Column Naming Note

The original design spec used `cost_per_1m_*` shorthand. The shipped migrations and all TypeScript code use the longer form `cost_per_million_*`. The longer form is canonical. Do not use `cost_per_1m_*` when querying the `roadmap` schema.

---

## Schema Details

### CHECK Constraints

Both tables received a non-negative check constraint:

```sql
-- model_metadata
ADD CONSTRAINT model_metadata_cost_per_million_nonnegative CHECK (
  (cost_per_million_input       IS NULL OR cost_per_million_input       >= 0) AND
  (cost_per_million_output      IS NULL OR cost_per_million_output      >= 0) AND
  (cost_per_million_cache_write IS NULL OR cost_per_million_cache_write >= 0) AND
  (cost_per_million_cache_hit   IS NULL OR cost_per_million_cache_hit   >= 0)
);

-- model_routes (same shape, constraint name: model_routes_cost_per_million_nonnegative)
```

### Precision Rationale

`numeric(12,6)` covers the full realistic pricing range:
- Cheapest open-weight route: ~$0.000800/M → 6 decimal places required
- Frontier cache-write: ~$75.000000/M → fits in 12 total digits

### NULL vs 0 Semantics

| Value | Meaning |
|-------|---------|
| `NULL` | Provider has no distinct pricing for this dimension; billing falls back to base input/output rate |
| `0` | Provider explicitly offers this dimension at zero cost (e.g., free-tier cache) |

These must never be conflated. Billing code must test `IS NOT NULL` / `!= null` before applying a cache column.

---

## Backfill Values

### Anthropic (migration 006)

| Model | Input ($/M) | Output ($/M) | Cache Hit ($/M) | Cache Write ($/M) |
|-------|-------------|--------------|-----------------|-------------------|
| claude-opus-4-6 | 15.000000 | 75.000000 | 1.500000 | 18.750000 |
| claude-sonnet-4-6 | 3.000000 | 15.000000 | 0.300000 | 3.750000 |
| claude-haiku-4-5 | 1.000000 | 5.000000 | 0.100000 | 1.250000 |

Cache write ≈ 125% of input; cache hit ≈ 10% of input (Anthropic standard ratios).

### Non-Anthropic providers (openai, google, xiaomi, nous, github)

Mechanical lift: `cost_per_million_* = cost_per_1k_* * 1000`. Cache columns remain `NULL` — these providers do not publish cache pricing.

Both migrations use `COALESCE` pattern and are safe to re-run.

---

## TypeScript Integration

### ModelRoute Interface (`src/core/orchestration/agent-spawner.ts`)

```typescript
export interface ModelRoute {
  // ...
  costPer1kInput: number;        // backward-compat alias: cost_per_million_input / 1000
  costPerMillionInput: number;   // canonical per-million value
  costPerMillionOutput: number;  // canonical per-million value
  // Cache columns are in the DB but not yet in ModelRoute (pending cache_* token columns on agent_runs)
}
```

### toModelRoute() Mapping

```typescript
const toModelRoute = (r: RouteRow): ModelRoute => ({
  // ...
  costPer1kInput: Number(
    r.cost_per_million_input ? r.cost_per_million_input / 1000 : 0,
  ),
  costPerMillionInput: Number(r.cost_per_million_input ?? 0),
  costPerMillionOutput: Number(r.cost_per_million_output ?? 0),
});
```

### Column-Existence Probe

`supportsPerMillionRoutePricing()` uses `information_schema.columns` to detect whether the migration has run. Result is cached per process lifetime. Probe is duplicated for `model_metadata` in `src/apps/mcp-server/tools/spending/pg-handlers.ts` as `supportsPerMillionModelPricing()`.

Recommended upgrade (not yet applied): replace `information_schema` probe with `pg_attribute` regclass cast for schema-qualified safety:

```typescript
const result = await query(`
  SELECT COUNT(*) AS cnt
  FROM   pg_attribute
  WHERE  attrelid = 'roadmap.model_routes'::regclass
    AND  attname  = 'cost_per_million_input'
    AND  NOT attisdropped
`);
return Number(result.rows[0].cnt) > 0;
```

### Billing Formula (reference — cache billing not yet wired to agent_runs)

```typescript
const inputCost = route.costPerMillionInput
  ? (run.tokens_in / 1_000_000) * route.costPerMillionInput
  : (run.tokens_in / 1000) * (route.costPer1kInput ?? 0);

const cacheWriteCost = route.cost_per_million_cache_write != null
  ? (run.cache_write_tokens / 1_000_000) * Number(route.cost_per_million_cache_write)
  : 0;

const cacheReadCost = route.cost_per_million_cache_hit != null
  ? (run.cache_read_tokens / 1_000_000) * Number(route.cost_per_million_cache_hit)
  : 0;
```

---

## Known Follow-ups

| # | Item | Blocking |
|---|------|---------|
| 1 | Add `cache_write_tokens` / `cache_read_tokens` columns to `agent_runs` before cache billing affects `cost_usd` | Yes — cache cost formula is wired but token source columns don't exist yet |
| 2 | Upgrade `supportsPerMillionRoutePricing()` from `information_schema` to `pg_attribute` probe | No |
| 3 | Populate cache pricing for Google / GitHub / OpenAI routes | No |
| 4 | Deprecate and drop `cost_per_1k_*` columns once all call sites are audited | No |

---

## Files Changed

| File | Change |
|------|--------|
| `database/ddl/v4/005_add_cost_per_million_columns.sql` | DDL — ADD COLUMN + CHECK constraints on both tables |
| `database/ddl/v4/006_backfill_cost_per_million_prices.sql` | Data backfill — Anthropic prices + mechanical lift |
| `src/core/orchestration/agent-spawner.ts` | `ModelRoute` interface + `toModelRoute()` + dual-path query |
| `src/apps/hive-cli/common/control-plane-types.ts` | `ModelRow` + `RouteRow` type definitions |
| `src/apps/mcp-server/tools/spending/pg-handlers.ts` | Model metadata upsert + `supportsPerMillionModelPricing()` probe |
