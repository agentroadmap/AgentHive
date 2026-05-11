# P280 — Dependency Integrity Guard for Proposal Obsolescence

**Status:** COMPLETE  
**Depends on:** P050 (DAG Dependency Engine), migration 011 (maturity-sync trigger), migration 020 (effective-blocking view)

---

## Overview

Before P280, a proposal could be silently set to `obsolete` while its dependents remained blocked on a dead reference. The dependency table had no enforcement: nothing stopped an upstream proposal from disappearing while downstream proposals held an unresolved `blocks` edge pointing at it.

P280 fixes this with **view-based soft resolution**: when a proposal's maturity reaches `obsolete` (or `mature`), the `v_effective_blocking` view automatically excludes it from active blocking calculations. Dependent proposals are unblocked dynamically — no row mutations required, dependency history preserved.

---

## Architecture Decision: View-Based Soft Resolution

Rather than a hard DB trigger that prevents the obsolescence transition, the system uses a view layer that interprets maturity state at query time.

**Why soft resolution instead of hard constraints:**

| Approach | Trade-off |
|---|---|
| Hard trigger (block the transition) | Requires explicit resolution of every dependency row before a proposal can be obsoleted — creates friction for cascades and terminal-state transitions |
| Row mutation (set resolved=true on all dependents) | Destroys historical dependency records; makes audit impractical |
| **View-based soft resolution (chosen)** | Dependents unblocked instantly; history preserved; `canPromote()` / `v_blocked_proposals` update dynamically |

The mechanism is: `v_effective_blocking` applies a filter `WHERE blocker.maturity_state NOT IN ('mature', 'obsolete')`. Obsoleting a proposal changes its `maturity_state`; the view picks this up on next query.

---

## Three Obsolescence Modes

### Mode 1 — Hard Obsolescence (Work Cancelled)

Triggered when a proposal transitions to `REJECTED`, `DISCARDED`, or `ABANDONED`. The `fn_sync_proposal_maturity` trigger (migration 011) maps these terminal statuses to `obsolete` maturity on every `UPDATE` to `roadmap.proposal`.

Once maturity is `obsolete`, `v_effective_blocking` excludes the proposal from all effective blocking calculations. All dependents are unblocked without any additional action. Agents holding work that depended on the cancelled proposal receive an implicit signal — their next `canPromote()` check will pass.

### Mode 2 — Replacement Obsolescence

When a superseding proposal exists, the agent:
1. Calls `resolveDependency()` on the old `blocks` edges pointing at the obsolete proposal.
2. Creates new `blocks` edges pointing to the replacement via `addDependency()`.

The `canPromote()` check on the replacement reflects the inherited relationships. This mode requires explicit agent action; the view layer does not automatically redirect edges.

### Mode 3 — Cascade Obsolescence

For tree-shaped cancellations (when dependents must also be cancelled), agents obsolete proposals depth-first. The recursive-CTE cycle guard in `DependencyHandlers.checkCycle()` prevents infinite loops during cascade operations:

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

As each node is set to `obsolete`, `v_effective_blocking` updates dynamically for the remaining unprocessed nodes in the subtree.

---

## Key Components

| Component | File | Purpose |
|---|---|---|
| `v_effective_blocking` | `scripts/migrations/020-effective-blocking-view.sql` | State-aware view; excludes obsolete/mature proposals from active blocking |
| `v_blocked_proposals` | `scripts/migrations/020-effective-blocking-view.sql` | Shows only proposals with live, unresolved blockers |
| `v_blocking_diagram` | `scripts/migrations/020-effective-blocking-view.sql` | Full bidirectional DAG with `is_effective_blocker` overlay |
| `fn_sync_proposal_maturity` | `scripts/migrations/011-maturity-sync-trigger.sql` | Trigger: maps `REJECTED/DISCARDED/ABANDONED` → `obsolete` maturity on status change |
| `DependencyHandlers.canPromote()` | `src/apps/mcp-server/tools/dependencies/handlers.ts:348` | Checks for unresolved `blocks` edges against a proposal |
| `DependencyHandlers.resolveDependency()` | `src/apps/mcp-server/tools/dependencies/handlers.ts:214` | Stamps `resolved=true`, `resolved_at`, `resolved_by` on a dependency row |
| `DependencyHandlers.checkCycle()` | `src/apps/mcp-server/tools/dependencies/handlers.ts:270` | Recursive CTE reachability check before INSERT |

---

## View Definitions

### `v_effective_blocking`

Shows every `blocks` dependency with its computed `effective_status`:

```
effective_status:
  'resolved'      — resolved_at IS NOT NULL (manual override)
  'auto_resolved' — blocker.maturity_state IN ('mature', 'obsolete')
  'blocking'      — dependency_type = 'blocks' (active blocker)
```

Key property: the view returns all rows including auto-resolved ones. Callers that only want active blockers must filter on `effective_status = 'blocking'`, or use `v_blocked_proposals` directly.

### `v_blocked_proposals`

Filtered view — only proposals with at least one live blocker:

```sql
WHERE d.dependency_type = 'blocks'
  AND d.resolved_at IS NULL
  AND blocker.maturity_state NOT IN ('mature', 'obsolete')
```

This is the canonical answer to "which proposals cannot advance right now."

### `v_blocking_diagram`

Bidirectional DAG view. Each row has a `direction` column (`i_depend_on` | `depends_on_me`) and `is_effective_blocker` boolean. Query by `proposal_id` to get full local neighbourhood in one shot.

---

## `proposal_dependencies` Schema Additions

Migration 020 adds two columns to `proposal_dependencies`:

| Column | Type | Purpose |
|---|---|---|
| `resolved_at` | `TIMESTAMPTZ DEFAULT NULL` | Timestamp of manual resolution; NULL = unresolved |
| `resolved_by` | `TEXT DEFAULT NULL` | Identity of agent or user who resolved the dependency |

These columns enable manual override independent of the upstream proposal's maturity. An agent can explicitly resolve a dependency even if the blocker is still active — useful for approved scope changes.

---

## Enforcement Invariants

1. **Obsolete proposals never block.** `v_effective_blocking` excludes any blocker whose `maturity_state` is `'mature'` or `'obsolete'` — no row mutation needed, no backfill required.

2. **Trigger is idempotent.** `fn_sync_proposal_maturity` only acts when `NEW.status IS DISTINCT FROM OLD.status`. Double-firing on the same terminal status is a no-op.

3. **Cycle guard on every INSERT.** `DependencyHandlers.checkCycle()` uses a recursive CTE reachability check before any `addDependency()` succeeds. The DB-level `fn_check_dag_cycle` trigger (baseline DDL) provides a second layer for direct DB writes.

4. **Manual resolve is additive.** Setting `resolved_at` does not delete the dependency row. The edge remains visible in `v_blocking_diagram` for audit, with `is_effective_blocker = false`.

---

## Known Gap: `canPromote()` Does Not Use `v_effective_blocking`

The design intended `canPromote()` to query `v_effective_blocking` so that an obsolete upstream automatically unblocks downstream promotion. The actual implementation queries the raw table:

```typescript
// handlers.ts:354
`SELECT from_proposal_id, dependency_type FROM roadmap_proposal.proposal_dependencies
 WHERE to_proposal_id = $1 AND dependency_type = 'blocks' AND NOT resolved`
```

This means `canPromote()` returns `false` if a `blocks` edge exists pointing to an obsolete upstream, even though `v_blocked_proposals` would show the proposal as unblocked.

**Workaround:** Agents should check `v_blocked_proposals` (via a direct DB query or the MCP `getDependencies` filter) rather than relying solely on `canPromote()` to determine promotability when upstream proposals may be obsolete. Alternatively, explicitly call `resolveDependency()` on edges pointing to obsolete proposals before promotion.

This gap is tracked for a follow-up fix: rewrite `canPromote()` to join against `v_effective_blocking` and filter on `effective_status = 'blocking'`.

---

## Migration History

| Migration | Description |
|---|---|
| `scripts/migrations/011-maturity-sync-trigger.sql` | Adds `trg_proposal_maturity_sync` and `fn_sync_proposal_maturity`; maps terminal statuses to `obsolete` maturity |
| `scripts/migrations/020-effective-blocking-view.sql` | Adds `resolved_at`/`resolved_by` columns; creates `v_effective_blocking`, `v_blocking_diagram`, replaces broken `v_blocked_proposals` |

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P050 | DAG Dependency Engine — core in-memory implementation (`src/core/dag/dependency-engine.ts`); DB-backed handler in `src/apps/mcp-server/tools/dependencies/handlers.ts` supersedes for production use |
| P281 | Resource hierarchy and offer/claim/lease system — shares `proposal_dependencies` table |
| P602 | Cross-project dependency checker — extends dependency model across project boundaries |
