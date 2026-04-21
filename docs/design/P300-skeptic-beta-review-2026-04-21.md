# Skeptic-Beta Review: P300 DEVELOP/new (2026-04-21)

**Reviewer:** worker-6715 (skeptic-beta)
**Verdict:** SEND_BACK — 3 ACs unmet, 2 blocking issues remain from previous review

---

## AC Status (verified from code, not self-report)

| AC | Projection | Actual | Evidence |
|---|---|---|---|
| AC-1 DB schema extended | ✅ | PASS | Migration 010 applied, columns exist |
| AC-2 Proposal-project link | ✅ | PASS | project_id NOT NULL DEFAULT 1, FK to projects |
| AC-3 PoolManager | ⏳ | PARTIAL | Class exists (pool.ts:308-518), initialized in orchestrator (line 1256). But `query()` function at line 290 still uses singleton `getPool()`. All 26 orchestrator `query()` calls bypass PoolManager. PoolManager.init() + metaPool alias used for LISTEN client only. |
| AC-4 Agency scoping | ✅ | PASS | offer-provider.ts:203 passes 4th param `$4` to fn_claim_work_offer |
| AC-5 squad_dispatch.project_id | ✅ | PASS | INSERT subquery at lines 630-631 and 901-905 |
| AC-6 git_root per project | ⏳ | NOT DONE | agent-spawner.ts:682 accepts `worktreeRoot` param (good). But orchestrator's `selectExecutorWorktree()` at line 337 has zero project awareness — scans WORKTREE_ROOT only. `dispatchAgent()` at line 453 never reads `projects.git_root`. Gate dispatch at line 1017 also hardcoded. No code path queries `projects.git_root` from DB. |
| AC-7 Cubic worktree fix | ✅ | PASS | orchestrator.ts:491 uses cubic_acquire worktree_path |
| AC-8 DB creation documented | ✅ | PASS | Procedure documented, script deferred |
| AC-9 Backward compat | ✅ | PASS | project_id=1 default on all existing data |
| AC-10 Connection budget | ✅ | PASS | DEFAULT_PROJECT_MAX = 3, MAX_PROJECT_POOLS = 10, math: 1 + (10 × 3) = 31 connections. Safe. |
| AC-11 Default project fallback | ⏳ | INSUFFICIENT | fn_claim_work_offer lines 96-102: fallback WHEN no provider_registry returns ALL projects (SELECT id FROM projects). AC requires project_id=1 only. |

---

## Blocking Issues

### B1: Orchestrator queries bypass PoolManager (AC-3)

The `query()` function (pool.ts:290) calls `getPool()` (singleton), not `poolManager.queryProject()`. The orchestrator imports both `query` and `PoolManager`, initializes PoolManager, but never routes any query through it.

**Impact:** When a second project DB is created, proposal queries will still hit the agenthive database. Multi-project dispatch is impossible with current code.

**Design question still unresolved:** Where does proposal data live — metaPool or per-project DBs? The design says per-project, but this creates a chicken-and-egg: need project_id to pick the pool, but proposal is in the per-project pool. Recommend: keep proposals in metaPool (coordination data, not work products). Eliminates routing complexity.

### B2: AC-6 git_root not wired to any dispatch path

agent-spawner.ts accepts `worktreeRoot` parameter — good. But no orchestrator code path reads `projects.git_root` and passes it through:
- `selectExecutorWorktree()` (line 337): scans filesystem under WORKTREE_ROOT, no project context
- `dispatchAgent()` (line 453): gets worktree from cubic_acquire (fine), but never sets worktreeRoot from project config
- Gate dispatch (line 1017): hardcoded worktree selection
- `spawnAgent()` calls (line 492, 1060): never pass worktreeRoot from project data

**Impact:** All projects share the same worktree root. Git isolation goal is not met.

### B3: AC-11 fallback returns all projects, not project_id=1

fn_claim_work_offer lines 96-102: when agency has no provider_registry entries, fallback is:
```sql
SELECT id FROM roadmap_workforce.projects
WHERE p_project_id IS NULL
  AND NOT EXISTS (...)
```
This returns ALL project IDs. AC requires: unregistered agencies only see project_id=1.

**Fix:** Add `AND id = 1` to the fallback CTE.

---

## Non-Blocking

- N1 (PG_PASSWORD env): FIXED — PoolManager:415 now reads `process.env.PGPASSWORD`.
- PoolManager class is solid — lazy creation, idle reaping, cap enforcement, health logging.
- offer-provider project_id wiring is correct (B1 from previous review resolved).
- Connection budget verified: 3 per pool, 10 max pools = 31 total connections. Safe.

---

## Remaining Work (4-6 hours)

1. **AC-11 fix (15 min):** Add `AND id = 1` to fallback CTE in fn_claim_work_offer.
2. **AC-6 wiring (2-3 hours):** In orchestrator, resolve project_id from proposal, read `projects.git_root`, pass as `worktreeRoot` to dispatchAgent/spawnAgent calls. Update selectExecutorWorktree to accept project context.
3. **AC-3 routing (2-3 hours):** Either replace `query()` calls with `poolManager.queryProject(projectId)` for proposal-scoped queries, OR update the design to keep proposals in metaPool (simpler, probably right).

---

## Recommendation

Do not advance until AC-6 and AC-11 are resolved. AC-3 needs a design decision (metaPool vs per-project for proposals) — if the answer is metaPool, AC-3 is immediately satisfied with the current code.
