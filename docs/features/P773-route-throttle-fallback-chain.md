# P773 — D7: Fallback Chain When Chosen Route Is Throttled

**Status:** COMPLETE  
**Layer:** 6 of 6 in `resolveModelRoute()` policy filter chain  
**Related:** P721 (throttle writer), P771 (Layers 1–4), P772 (route decision log), P742 (`NoPolicyAllowedRoute`)

---

## Problem

When a provider responds with a usage-cap signal, P721 writes `cooldown_until = NOW() + '5 min'` on the offending `model_routes` row. Without a Layer 6 filter, `resolveModelRoute()` could still return a throttled route — the next dispatch would immediately hit the same cap, burn a run entry, and re-throttle without making progress.

---

## Solution

Layer 6 extends the 5-layer AND filter chain in `resolveModelRoute()` with a direct column expression that excludes any route whose `cooldown_until` timestamp is in the future. Because the check uses `<= NOW()` with no stored parameter, cooldowns expire automatically — no background job or manual reset is required (AC-5).

### Database change — migration 098

`scripts/migrations/098-p773-route-cooldown.sql`

```sql
ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_model_routes_cooldown
  ON roadmap.model_routes (cooldown_until)
  WHERE cooldown_until IS NOT NULL;
```

The partial index ensures the predicate `WHERE cooldown_until IS NOT NULL` is evaluated cheaply even when most rows have `NULL` (the normal, non-throttled state).

---

## Implementation

### Layer 6 SQL fragment — `cooldownFilterSql`

`src/core/orchestration/resolvers/route-policy-filters.ts`

```ts
export function cooldownFilterSql(alias = "mr"): string {
  return `(${alias}.cooldown_until IS NULL OR ${alias}.cooldown_until <= NOW())`;
}
```

This is a **parameter-free** expression — it uses the database clock directly. It open-passes (allows) a route when:
- `cooldown_until IS NULL` — no throttle has ever been applied, or it was cleared.
- `cooldown_until <= NOW()` — a previous throttle has elapsed.

The filter is injected into every route query inside `resolveModelRoute()` via the shared `policyFilters` / `defaultPolicyFilters` string, alongside Layers 1–5.

### Elimination diagnostic — `buildEliminationDiagnosticSql`

The diagnostic CASE-WHEN chain that feeds `route_decision_log.eliminated_routes` was extended with a Layer 6 arm placed between `'budget_exhausted'` and `'passed'`:

```sql
WHEN NOT (mr.cooldown_until IS NULL OR mr.cooldown_until <= NOW()) THEN 'throttled'
```

Routes excluded only by their cooldown timestamp emit `reason = 'throttled'` in the `eliminated_routes` JSONB array (AC-4).

### `NoPolicyAllowedRoute.all_throttled` flag

`src/core/orchestration/agent-spawner.ts`

When `resolveModelRoute()` finds no passing route, it now runs a secondary diagnostic:

1. Checks whether any enabled routes exist for the provider at all.
2. If yes, queries how many pass Layers 1–5 but are blocked only by `cooldown_until > NOW()`.
3. If that count is non-zero, throws `NoPolicyAllowedRoute` with `{ all_throttled: true }`.

```ts
throw new NoPolicyAllowedRoute(AGENTHIVE_HOST, provider, hint ?? null, {
  all_throttled: allThrottled,
});
```

The error message distinguishes the two failure modes:

| `all_throttled` | Message suffix |
|---|---|
| `true` | `All routes are in cooldown — retry after throttle window elapses.` |
| `false` | `Check roadmap.host_model_policy.` |

Callers (the orchestrator's dispatch loop) can inspect `err.all_throttled` to decide whether to back off and retry versus escalate immediately.

### `EliminationReason` type

`src/core/orchestration/resolvers/route-resolver.types.ts`

```ts
export type EliminationReason =
  | "host_policy"
  | "project_policy"
  | "agency_policy"
  | "role_policy"
  | "budget_exhausted"
  | "throttled";       // ← P773
```

---

## Acceptance Criteria Verification

| AC | Mechanism | Verified by |
|---|---|---|
| AC-1: `cooldown_until > NOW()` route excluded | Layer 6 `cooldownFilterSql` in all route queries | `cooldownFilterSql` unit tests |
| AC-2: Secondary route returned when primary throttled | `ORDER BY priority ASC, cost_per_million_input ASC` picks next eligible | Integration: DB test |
| AC-3: `NoPolicyAllowedRoute` with `all_throttled=true` when all throttled | Secondary diagnostic query + flag set in catch branch | Unit: `NoPolicyAllowedRoute all_throttled flag` |
| AC-4: Throttled routes in `eliminated_routes` with `reason='throttled'` | `buildEliminationDiagnosticSql` Layer 6 arm | Unit: `buildEliminationDiagnosticSql Layer 6 throttled` |
| AC-5: Route auto-recovers after `cooldown_until` elapses | `<= NOW()` predicate — no manual reset needed | SQL design (no background job) |

---

## Files Changed

| File | Change |
|---|---|
| `scripts/migrations/098-p773-route-cooldown.sql` | Add `cooldown_until` column + partial index to `roadmap.model_routes` |
| `src/core/orchestration/resolvers/route-policy-filters.ts` | Add `cooldownFilterSql()` (Layer 6); extend `buildEliminationDiagnosticSql` with `'throttled'` arm |
| `src/core/orchestration/resolvers/route-resolver.types.ts` | Add `"throttled"` to `EliminationReason` union |
| `src/core/orchestration/agent-spawner.ts` | Wire `cooldownFilterSql` into all route queries; extend `NoPolicyAllowedRoute` with `all_throttled` flag; add secondary diagnostic query |
| `tests/unit/route-fallback-chain.test.ts` | Unit tests for `cooldownFilterSql`, `buildEliminationDiagnosticSql` Layer 6 ordering, `EliminationReason` type, and `NoPolicyAllowedRoute.all_throttled` shape |

---

## Interaction with P721

P721 is the **writer**: it sets `cooldown_until = NOW() + interval '5 min'` when `classifyExit()` detects a rate-limit signal in agent stdout/stderr. P773 is the **reader**: it treats that column as an exclusion predicate. The two proposals are deliberately decoupled — P773 does not call P721 code and P721 does not know about the filter chain.

If P721's cooldown window ever changes from 5 minutes, P773 requires no code change — the `<= NOW()` expression reads whatever value P721 stored.

---

## Fallback Ordering

Within the surviving (non-throttled) eligible set, route selection order is:

1. `is_default = true` routes preferred (default-selection queries only)
2. `priority ASC` — lower priority number wins
3. `COALESCE(cost_per_million_input, 0) ASC` — cheapest among equal-priority
4. `id ASC` — deterministic tiebreak

This means the fallback to a lower-priority route is deterministic and cost-aware: if the primary (priority 1) route is throttled, the dispatcher reliably picks the cheapest priority-2 route without any randomness or manual intervention.
