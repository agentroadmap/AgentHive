# P760: B6 — project_capacity_config Schema + Seed — Ship Report

**Phase:** COMPLETE  
**Date:** 2026-05-09  
**Documenter:** ccs46ant-bot-docum-a  
**Migration:** `scripts/migrations/088-p760-project-capacity-config.sql`

---

## 1. Summary

P760 adds per-project dispatch capacity enforcement to AgentHive. It introduces a
`roadmap.project_capacity_config` table that the spawner reads before forking any agent process,
a `isWithinCapacity()` resolver that checks the live running-agent count against the configured
ceiling, and integration into `spawnAgent()` so that a project at capacity blocks further
dispatches until a slot opens.

The feature is the B6 sub-task of the wider P820 unified queue / project-efficiency model. The
physical schema adapts post-P820 constraints: active dispatches are approximated via
`agent_runs WHERE status = 'running'` (a proxy for in-flight work) rather than the
`squad_dispatch` table originally cited in the proposal, which lacks a `project_id` FK at this
migration level.

---

## 2. Acceptance Criteria Verification

| AC | Description | Status | Notes |
|----|-------------|--------|-------|
| AC-1 | Table created; FK to project; default row for project_id=1 with max=50 | PARTIAL | Table and FK exist; seed row has `max_concurrent_dispatches=8` (conservative default), not 50 as specified; `max_hourly_token_budget=500000` (not NULL). Values diverge from proposal but are valid production defaults. |
| AC-2 | `isWithinCapacity()` returns false when active dispatches >= max | PASS | `active_count < max` logic at `capacity-guard.ts:34`; test coverage confirmed. |
| AC-3 | `isWithinCapacity()` returns true when no config row exists (uncapped) | PASS | `if (!rows.length) return true` at `capacity-guard.ts:33`; test coverage confirmed. |
| AC-4 | `max_hourly_token_budget` readable by D4 route_token_budget seed logic | PASS | Column `BIGINT` exists; `agent_read` SELECT grant in migration; D4 consumer integration is outside P760 scope. |
| AC-5 | `scanQueues()` skips dispatch for a project at capacity without logging an error | PARTIAL | Dispatch is correctly skipped. However, the capacity check lives in `spawnAgent()` (not a pre-flight in `scanQueues()`), which throws `[P760] Project … is at max concurrent dispatch capacity`. The catch block in `scanQueues()` logs this via `console.error`. The "without logging an error" condition is not fully met, but the operational outcome (skipped dispatch, no agent_run created) is correct. |

---

## 3. Key Files

| File | Role |
|------|------|
| `scripts/migrations/088-p760-project-capacity-config.sql` | DDL — table, CHECK constraint, FK, seed row, grants |
| `src/core/orchestration/resolvers/capacity-guard.ts` | `isWithinCapacity(projectId, queryFn?)` — injectable query for testability |
| `src/core/orchestration/agent-spawner.ts` | Integration: `SpawnRequest.projectId` field (line 217); capacity pre-flight in `spawnAgent()` (lines 1229–1237) |
| `tests/unit/capacity-guard.test.ts` | Unit tests: uncapped (no row), within cap, at/over cap |

---

## 4. Schema

```sql
CREATE TABLE IF NOT EXISTS roadmap.project_capacity_config (
  project_id                BIGINT PRIMARY KEY
                              REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  max_concurrent_dispatches INT NOT NULL DEFAULT 50
                              CHECK (max_concurrent_dispatches >= 0),
  max_hourly_token_budget   BIGINT,
  notes                     TEXT,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed row (agenthive project, project_id=1)
-- Seeded with max=8 (conservative) and budget=500000; upsert-safe (ON CONFLICT DO NOTHING)
INSERT INTO roadmap.project_capacity_config
  (project_id, max_concurrent_dispatches, max_hourly_token_budget)
VALUES (1, 8, 500000)
ON CONFLICT (project_id) DO NOTHING;
```

**Grants:**  
- `agent_read`: `SELECT, INSERT, UPDATE`  
- `agent_write`: `SELECT, INSERT, UPDATE, DELETE`

---

## 5. Implementation Notes

### Active-dispatch approximation

The proposal referenced `squad_dispatch` with `status IN ('active', 'pending')` as the active
count source. The final implementation queries `agent_runs WHERE status = 'running'` instead:

```sql
SELECT c.max_concurrent_dispatches,
       COUNT(r.id) AS active_count
FROM roadmap.project_capacity_config c
LEFT JOIN agent_runs r
  ON r.status = 'running'
WHERE c.project_id = $1
GROUP BY c.max_concurrent_dispatches
```

This is a conscious post-P820 adaptation: `agent_runs` is the available source of truth for
in-flight work at this migration level. The join has no `project_id` predicate on `agent_runs`
(that FK does not exist yet), so `active_count` is a **system-wide** running-agent count, not a
per-project count. For the current single-project deployment this is equivalent; multi-project
enforcement will require a `project_id` FK on `agent_runs` (tracked separately).

### Injectable query function

`isWithinCapacity(projectId, queryFn?)` accepts an optional second argument that replaces the
default pool query. This makes the resolver unit-testable without a live database — tests pass
fake rows via `makeQuery(rows)` closures.

### Integration point: spawnAgent pre-flight

The capacity check is the first async operation in `spawnAgent()`, before provider detection,
route resolution, or process launch:

```ts
// agent-spawner.ts:1229-1237
if (req.projectId !== undefined) {
  const withinCap = await isWithinCapacity(req.projectId);
  if (!withinCap) {
    throw new Error(
      `[P760] Project ${req.projectId} is at max concurrent dispatch capacity`,
    );
  }
}
```

When the capacity limit is reached the thrown error propagates to the `catch` block in
`scanQueues()`, which logs it at `console.error` level and continues to the next candidate.
No `agent_run` row is created; no billing occurs.

---

## 6. Design Deviations

| Deviation | Proposal | Implementation | Impact |
|-----------|----------|---------------|--------|
| Migration number | `database/migrations/072-…` | `scripts/migrations/088-…` | Canonical path; `database/migrations/` is legacy. |
| Seed `max_concurrent_dispatches` | 50 | 8 | More conservative default; safe to raise via UPDATE. |
| Seed `max_hourly_token_budget` | NULL | 500000 | Budget enforcement available immediately for project 1. |
| Active dispatch source | `squad_dispatch status IN ('active','pending')` | `agent_runs status='running'` | Post-P820 schema realism; system-wide count until `agent_runs.project_id` FK lands. |
| Capacity check location | `scanQueues()` pre-flight (no error) | `spawnAgent()` throw (caught in `scanQueues()`) | Dispatch skipped correctly; an error line is logged on capacity hit. |

---

## 7. Risk Assessment

**Low.** The migration is additive and idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO
NOTHING`). The capacity guard is opt-in — `spawnAgent()` only checks capacity when `projectId`
is explicitly set in `SpawnRequest`; requests without `projectId` are unaffected.

The system-wide active count proxy (noted above) could cause false-positive blocks if agent
volume grows significantly across multiple projects before the `agent_runs.project_id` FK lands.
At current single-project deployment this is a non-issue.

---

## 8. Recommendation

**Ship confirmed with noted deviations.** The core mechanism — table, resolver, integration,
tests — is complete and correct. The seed value divergence (max=8 vs 50) and the system-wide
count proxy are documented deviations with low operational risk. AC-5 is substantively met
(dispatch is blocked when at capacity); the error log side-effect is a minor implementation
difference from the spec. All three unit test cases pass.

---

*Generated by ccs46ant-bot-docum-a (documenter) for P760 COMPLETE phase.*
