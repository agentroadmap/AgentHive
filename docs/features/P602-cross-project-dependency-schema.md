# P602 — Cross-Project Dependency Graph Schema

**Status:** COMPLETE  
**Depends on:** P483 (project lifecycle ops / project registry — `roadmap.project` FK target; P483 supersedes the now-obsolete P482), P820 (arch umbrella — held schema review)

---

## Overview

P602 introduces a typed, directed dependency graph that spans project tenant boundaries in AgentHive. Prior to this proposal, `roadmap_proposal.proposal_dependencies` tracked intra-project edges only. P602 adds a dedicated `dependency` schema in `hiveCentral` with two tables — a kind catalog and an edge store — plus a nightly BFS cycle detector and proposal-event signals for cycles and orphaned project references.

**v1 scope (this proposal):** nightly batch consistency job, 86 400 000 ms interval. No real-time auditor.  
**v2 (deferred):** pg_notify-based real-time auditor activating when edge count > 50. Separate follow-up proposal; no LISTEN/NOTIFY DDL is present in migration 058.

---

## Schema

### `dependency.dependency_kind_catalog`

Registry of valid edge kinds. Seeded at migration time; new kinds must be INSERT'd here before an edge of that kind can be created.

| Column | Type | Notes |
|---|---|---|
| `kind` | TEXT PK | Natural key (e.g. `blocks`, `informed_by`) |
| `is_directional` | BOOLEAN | Whether edge has an implied direction |
| `cycle_check` | BOOLEAN | If true, the nightly BFS considers edges of this kind |
| `description` | TEXT | Human-readable description |

**Seed rows (migration 058):**

| kind | cycle_check | Meaning |
|---|---|---|
| `blocks` | true | from-project cannot advance until to-project delivers |
| `informed_by` | false | Informational reference; no gate |
| `supersedes` | false | from-project replaces to-project |
| `requires_artifact` | false | Mutual artifact dependency; non-directional |

### `dependency.cross_project_dependency`

Directed edge store. Each row is one typed dependency crossing a project boundary.

| Column | Type | Notes |
|---|---|---|
| `edge_id` | BIGSERIAL PK | Stable edge identifier |
| `from_project_id` | BIGINT FK → `roadmap.project` | Dependent project |
| `from_proposal_id` | BIGINT | Dependent proposal within `from_project_id` |
| `to_project_id` | BIGINT FK → `roadmap.project` | Provider project |
| `to_proposal_id` | BIGINT | Provider proposal within `to_project_id` |
| `kind` | TEXT FK → `dependency_kind_catalog` | Edge type |
| `resolved_at` | TIMESTAMPTZ | NULL = unresolved; set when dependency satisfied |
| `created_at` | TIMESTAMPTZ | Row creation time |

**Constraints:**

- `CONSTRAINT cross_project_no_self_loop CHECK (from_project_id != to_project_id)` — hard DB guarantee; same-project edges cannot enter this table (they belong in `roadmap_proposal.proposal_dependencies`).
- `CONSTRAINT cross_project_dep_unique UNIQUE (from_project_id, from_proposal_id, to_project_id, to_proposal_id, kind)` — deduplication guard.

**Partial indexes (unresolved edges only):**

```sql
idx_cross_dep_from    ON (from_project_id, from_proposal_id)  WHERE resolved_at IS NULL
idx_cross_dep_to      ON (to_project_id,   to_proposal_id)    WHERE resolved_at IS NULL
idx_cross_dep_unresolved ON (resolved_at)                     WHERE resolved_at IS NULL
```

### `proposal_event` extension

Migration 058 drops and recreates `proposal_event_type_check` to add two new event types:

| New event type | Emitted by |
|---|---|
| `cross_dep_cycle_detected` | Nightly consistency job — BFS found a cycle |
| `cross_dep_orphan_detected` | Nightly consistency job — edge references a project not in `roadmap.project` |

---

## Implementation

### `cross-dep-service.ts` — Sole write path

**File:** `src/core/cross-project/cross-dep-service.ts`

`addCrossProjectDependency(pool, edge)` is the only way to insert a row into `cross_project_dependency`. It:

1. Validates `edge.kind` against `dependency_kind_catalog`. Returns `{ ok: false, error }` (not a throw) for unknown kinds.
2. Executes the INSERT. Returns typed errors for the two expected constraint violations (`cross_project_dep_unique`, `cross_project_no_self_loop`). Re-throws unexpected DB errors.
3. Returns `{ ok: true, edgeId }` on success.

```typescript
export type EdgeInput = {
  fromProjectId: bigint;
  fromProposalId: bigint;
  toProjectId: bigint;
  toProposalId: bigint;
  kind: string;
};
export type AddEdgeResult = { ok: true; edgeId: bigint } | { ok: false; error: string };
export async function addCrossProjectDependency(pool, edge): Promise<AddEdgeResult>
```

v1 does not perform inline cycle detection — cycles are discovered post-hoc by the nightly job.

### `cross-project-dependency-checker.ts` — BFS cycle detector

**File:** `src/core/cross-project/cross-project-dependency-checker.ts`

Pure function — no DB access. Receives a flat list of `CrossProjectEdge` objects (loaded from DB by the consistency job) and returns detected cycles.

**Node key encoding:** `"${projectId}:${proposalId}"` — composite string key safe for BIGSERIAL IDs (no colon in numeric values).

**Algorithm:** Queue-based BFS adapted from `dependency-engine.ts:72–99`. Each BFS traversal carries a `pathSet` (nodes visited on the current path). When a neighbor is found in the current `pathSet`, a cycle is recorded with the edge IDs that form it. `globalVisited` prevents redundant BFS restarts from already-explored nodes.

```typescript
export function detectCycles(edges: CrossProjectEdge[]): CycleResult[]
// CycleResult = { hasCycle: true; cycleEdgeIds: bigint[] }
```

**Important:** cycles are detected and reported; they are **not auto-broken**. Manual resolution is required.

### `cross-dep-consistency-job.ts` — Nightly job

**File:** `src/core/cross-project/cross-dep-consistency-job.ts`

Runs every 86 400 000 ms (24 h) via `setInterval`. Guards against duplicate registration — `startNightlyConsistencyJob()` is a no-op if `jobHandle` is already set.

**`runCrossDepConsistencyCheck(pool)` steps:**

1. **Cycle check (blocking kinds only):** Query unresolved edges with `cycle_check = true` via a JOIN on `dependency_kind_catalog`. Build `CrossProjectEdge[]`, call `detectCycles()`. For each detected cycle, emit `cross_dep_cycle_detected` on `from_proposal_id` of the anchor edge, with payload `{ edge_ids: string[] }`.

2. **Orphan check (all unresolved edges):** Collect the full distinct set of `project_id`s referenced by unresolved edges. For each, call `resolveProjectSlug()` (checks `roadmap.project WHERE status = 'active'`). Any project returning `null` is "unresolvable." For each edge touching an unresolvable project, emit `cross_dep_orphan_detected` with payload `{ edge_id, check_skipped: true }`.

**`check_skipped: true` rationale:** The orphan field is set on *every* orphan event — it signals that the dependency validity check was skipped (not performed), not that the project was confirmed missing. This prevents false-positive alerts when a project exists but is unreachable due to partial DB outage (full resolution deferred to P474).

**Exported lifecycle API:**

```typescript
export function startNightlyConsistencyJob(pool: Pool): void
export function stopNightlyConsistencyJob(): void
export async function runCrossDepConsistencyCheck(pool: Pool): Promise<void>
```

---

## Tests

**File:** `tests/unit/p602-cross-project-dependency-checker.test.ts`

Unit tests cover `detectCycles()` in isolation (no DB). Scenarios:

| Test | Description |
|---|---|
| Acyclic graph | Returns `[]` for a straight P1→P2→P3 chain |
| Two-node cycle | P1→P2→P1 detected; `cycleEdgeIds` non-empty |
| Three-node cycle | P1→P2→P3→P1 detected |
| Empty input | Returns `[]` |
| Self-loop (same project_id) | Detected — note the DB CHECK prevents this in practice |
| Disconnected acyclic chains | No false positives across independent subgraphs |
| Edge ID attribution | `cycleEdgeIds` contains the IDs of participating edges |

---

## Grants (migration 058)

```sql
GRANT USAGE ON SCHEMA dependency TO roadmap_agent;
GRANT SELECT ON dependency.dependency_kind_catalog TO roadmap_agent;
GRANT SELECT, INSERT ON dependency.cross_project_dependency TO roadmap_agent;
GRANT USAGE ON SEQUENCE dependency.cross_project_dependency_edge_id_seq TO roadmap_agent;
```

---

## Migration History

| File | Slot | Notes |
|---|---|---|
| `scripts/migrations/058-p602-cross-project-dependency.sql` | 058 | Original DDL. Schema matches TypeScript source code. Adds 2 event types to 11-value check constraint (total 13). |
| `scripts/migrations/084-p602-cross-project-dependency.sql` | 084 | Revised DDL targeting hiveCentral; alternative schema design (`id` PK, `kind_id` FK, `name` in catalog). |
| `scripts/migrations/086-p602-cross-project-dependency.sql` | 086 | Adaptation for agenthive tenant DB. Failed to apply: proposal_event_type_check on live DB had 25 values; migration only listed 11. |
| `scripts/migrations/095-p602-cross-project-dependency.sql` | 095 | Corrective migration replacing 086. Includes full 25-value event_type list (+ 2 new = 27). Uses the 084/086 schema variant (different from 058 schema). |

**Schema divergence note:** The TypeScript source files (`cross-dep-service.ts`, `cross-dep-consistency-job.ts`, `cross-project-dependency-checker.ts`) are written against the `058` schema — `edge_id` BIGSERIAL PK, `kind` TEXT FK, `from_proposal_id`/`to_proposal_id` columns, `cycle_check` boolean in the kind catalog. The `095` migration installs a divergent schema (`id` BIGINT IDENTITY PK, `kind_id` BIGINT FK, `reference_id`/`reference_type` replacing proposal ID columns, `name` in catalog). The TypeScript code will not function correctly against the `095`-created schema without alignment work.

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P483 | Phase 1 project registry — creates `roadmap.project(project_id)`, the FK target for both project columns (successor to now-obsolete P482) |
| P820 | Arch umbrella under which P602 schema was held for review |
| P474 | Multi-project bootstrap — project slug resolution; orphan detection deferred full resolution to P474 |
| P604 | Observability schema occupying migration slot 059 (codex-three branch) |
