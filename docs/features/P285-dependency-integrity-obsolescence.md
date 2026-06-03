# P285 — Dependency Integrity Guard for Proposal Obsolescence

**Status:** COMPLETE  
**Related:** P280 (architectural origin), P050 (DAG Dependency Engine), P602 (Cross-project deps)  
**Migrations:** 011-maturity-sync-trigger, 020-effective-blocking-view

---

## Problem

Before this work, the proposal DAG had no enforcement at the point of obsolescence. A proposal could be silently set to `REJECTED`, `DISCARDED`, or `ABANDONED` while its dependents held unresolved `blocks` edges pointing at it. Those dependents remained perpetually blocked on a dead reference with no automatic relief.

---

## Architecture Decision: View-Based Soft Resolution

Rather than a hard DB trigger that prevents the obsolescence transition (and forces agents to resolve every edge before cancelling a proposal), the system uses **view-based soft resolution**:

- When a proposal's `maturity_state` becomes `obsolete`, the `v_effective_blocking` view immediately excludes it from active blocking calculations.
- Dependent proposals are unblocked dynamically on the next query — no row mutations, no backfill.
- Historical dependency rows are preserved for audit.

| Approach | Trade-off |
|---|---|
| Hard trigger (block the transition) | Requires explicit resolution of every edge before obsolescence; creates cascade friction |
| Row mutation (set `resolved=true` on all edges) | Destroys historical records; audit becomes impractical |
| **View-based soft resolution (chosen)** | Instant unblocking; history intact; `v_blocked_proposals` and `canPromote()` update on next query |

---

## Three Obsolescence Modes

### Mode 1 — Hard Obsolescence (Work Cancelled)

Triggered when a proposal transitions to `REJECTED`, `DISCARDED`, or `ABANDONED`. The `fn_sync_proposal_maturity` trigger (migration 011) maps these terminal statuses to `obsolete` maturity on every `UPDATE` to `roadmap.proposal`.

Once `maturity_state = 'obsolete'`, `v_effective_blocking` excludes the proposal. All dependents are unblocked without any additional action. The next `canPromote()` call on a formerly-blocked proposal will reflect the relief.

### Mode 2 — Replacement Obsolescence

When a superseding proposal exists, the agent:

1. Calls `resolveDependency()` on old `blocks` edges pointing at the obsolete proposal (stamps `resolved_at` + `resolved_by`).
2. Creates new `blocks` edges pointing to the replacement via `addDependency()`.

The `canPromote()` check on the replacement reflects the inherited relationships. This mode requires explicit agent action — the view layer does not automatically redirect edges to a replacement.

### Mode 3 — Cascade Obsolescence

For tree-shaped cancellations (when dependents must also be cancelled), agents obsolete proposals depth-first. `DependencyHandlers.checkCycle()` uses a recursive CTE reachability check before any `addDependency()`:

```sql
WITH RECURSIVE reach AS (
  SELECT to_proposal_id FROM roadmap_proposal.proposal_dependencies
  WHERE from_proposal_id = $1 AND NOT resolved
  UNION
  SELECT d.to_proposal_id FROM roadmap_proposal.proposal_dependencies d
  JOIN reach r ON d.from_proposal_id = r.to_proposal_id
  WHERE NOT d.resolved
)
SELECT EXISTS(SELECT 1 FROM reach WHERE to_proposal_id = $2) as found
```

As each node is marked `obsolete`, `v_effective_blocking` updates dynamically for the remaining subtree.

---

## Key Components

| Component | Location | Role |
|---|---|---|
| `v_effective_blocking` | `scripts/migrations/020-effective-blocking-view.sql` | State-aware view; excludes `obsolete`/`mature` proposals from active blocking |
| `v_blocked_proposals` | `scripts/migrations/020-effective-blocking-view.sql` | Canonical "what's blocked right now" — filters on `resolved_at IS NULL` + maturity |
| `v_blocking_diagram` | `scripts/migrations/020-effective-blocking-view.sql` | Bidirectional DAG with `is_effective_blocker` boolean per edge |
| `fn_sync_proposal_maturity` | `scripts/migrations/011-maturity-sync-trigger.sql` | Trigger: maps `REJECTED/DISCARDED/ABANDONED` → `obsolete` maturity on `UPDATE` |
| `fn_check_dag_cycle` | `database/ddl/roadmap-baseline-2026-04-13.sql` | DB-level cycle guard on every `INSERT/UPDATE` to `proposal_dependencies` |
| `DependencyHandlers.canPromote()` | `src/apps/mcp-server/tools/dependencies/handlers.ts:348` | Checks unresolved `blocks` edges for a given proposal |
| `DependencyHandlers.resolveDependency()` | `src/apps/mcp-server/tools/dependencies/handlers.ts:214` | Stamps `resolved`, `resolved_at`, `resolved_by` on a dependency row |
| `DependencyHandlers.checkCycle()` | `src/apps/mcp-server/tools/dependencies/handlers.ts:270` | Recursive CTE reachability check before `addDependency()` |

---

## View Definitions

### `v_effective_blocking`

Computes `effective_status` for every `blocks` dependency:

```
effective_status:
  'resolved'      — resolved_at IS NOT NULL (manual override via resolveDependency())
  'auto_resolved' — blocker.maturity_state IN ('mature', 'obsolete')
  'blocking'      — everything else; this edge is an active blocker
```

The view returns **all** rows including resolved ones. Callers that want only active blockers must filter `effective_status = 'blocking'`, or use `v_blocked_proposals`.

### `v_blocked_proposals`

Shows only proposals with at least one live blocker:

```sql
WHERE d.dependency_type = 'blocks'
  AND d.resolved_at IS NULL
  AND blocker.maturity_state NOT IN ('mature', 'obsolete')
```

This is the canonical query for "which proposals cannot advance right now."

### `v_blocking_diagram`

Bidirectional DAG view. Each row has:
- `direction`: `i_depend_on` (I block something) | `depends_on_me` (something blocks me)
- `is_effective_blocker`: boolean — `true` only when `resolved_at IS NULL` and blocker `maturity_state NOT IN ('mature', 'obsolete')`

Query by `proposal_id` to get the full local neighbourhood in one shot.

---

## `proposal_dependencies` Schema Additions (migration 020)

| Column | Type | Purpose |
|---|---|---|
| `resolved_at` | `TIMESTAMPTZ DEFAULT NULL` | Timestamp of manual resolution; `NULL` = unresolved |
| `resolved_by` | `TEXT DEFAULT NULL` | Identity of agent or user who resolved the dependency |

`resolveDependency()` sets both the `resolved` boolean and `resolved_at` together, keeping them in sync. The views use `resolved_at IS NULL` for resolution detection; `canPromote()` uses the `resolved` boolean — both paths are kept consistent by `resolveDependency()`.

---

## Enforcement Invariants

1. **Obsolete proposals never block.** `v_effective_blocking` excludes any blocker with `maturity_state IN ('mature', 'obsolete')` — no row mutation needed, no backfill required.

2. **Trigger is idempotent.** `fn_sync_proposal_maturity` only acts when `NEW.status IS DISTINCT FROM OLD.status`. Double-firing on the same terminal status is a no-op.

3. **Two-layer cycle guard.** `DependencyHandlers.checkCycle()` (application layer) runs before every `addDependency()`. `fn_check_dag_cycle` (DB trigger, `BEFORE INSERT OR UPDATE`) provides a second enforcement layer for direct DB writes.

4. **Manual resolve is additive.** `resolveDependency()` stamps `resolved_at` but does not delete the row. The edge stays visible in `v_blocking_diagram` with `is_effective_blocker = false` for audit purposes.

---

## Known Gap: `canPromote()` Queries Raw Table

`canPromote()` was intended to validate promotability via `v_effective_blocking`. The actual implementation at `handlers.ts:354` queries the raw table instead:

```typescript
`SELECT from_proposal_id, dependency_type FROM roadmap_proposal.proposal_dependencies
 WHERE to_proposal_id = $1 AND dependency_type = 'blocks' AND NOT resolved`
```

This means `canPromote()` returns `blockedBy: [{...}]` for an edge pointing to an obsolete upstream — even though `v_blocked_proposals` and `v_effective_blocking` both report the proposal as unblocked.

**Workaround:** Agents relying on `canPromote()` when an upstream proposal may have been obsoleted should either:
- Query `v_blocked_proposals` directly (reliable), or
- Call `resolveDependency()` on edges pointing to the now-obsolete proposal before calling `canPromote()`.

A follow-up fix (not in scope for P285) would rewrite `canPromote()` to join against `v_effective_blocking` and filter on `effective_status = 'blocking'`.

---

## Migration History

| Migration | Description |
|---|---|
| `scripts/migrations/011-maturity-sync-trigger.sql` | Adds `trg_proposal_maturity_sync` + `fn_sync_proposal_maturity`; maps `REJECTED/DISCARDED/ABANDONED` → `obsolete` maturity |
| `scripts/migrations/020-effective-blocking-view.sql` | Adds `resolved_at`/`resolved_by` columns; creates `v_effective_blocking`, `v_blocking_diagram`; replaces broken `v_blocked_proposals` |

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P050 | DAG Dependency Engine — core in-memory implementation; DB-backed `DependencyHandlers` supersedes for production |
| P280 | Architectural origin of this feature; established the view-based soft resolution pattern |
| P281 | Resource hierarchy and offer/claim/lease — shares `proposal_dependencies` table |
| P602 | Cross-project dependency checker — extends the dependency model across project boundaries |
