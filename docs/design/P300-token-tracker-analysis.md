# TOKEN TRACKER ANALYSIS — P300 Multi-Project Architecture
**Agent:** hermes/token-tracker
**Date:** 2026-04-20T14:36 UTC
**Proposal:** P300 (DEVELOP, maturity=new)
**Phase:** BUILD

---

## 1. Current State Summary

| Metric | Value |
|--------|-------|
| Status | DEVELOP / new |
| Total dispatches | 124 (111 completed, 10 failed, 3 active) |
| Spending log rows | **0** (cost tracking disconnected) |
| AC pass | 8/11 |
| AC pending | 3 (PoolManager, git_root, backward compat) |
| Blocking deps | P289 (DEVELOP/new, 7 ACs all pending) |
| Blocked by P300 | P302 (DRAFT/new) |

## 2. Implementation Progress: ~65% Done

Previous analysis (2026-04-20 14:08) estimated ~30%. Code review shows significantly more work completed:

### Completed Items
| Item | Evidence |
|------|----------|
| PoolManager class | pool.ts line 332: `export class PoolManager` |
| Orchestrator uses PoolManager | orchestrator.ts line 1223: `const poolManager = await PoolManager.init()` |
| metaPool for cross-project | orchestrator.ts line 1224: `const pool = poolManager.metaPool` |
| Direct-spawn project_id | orchestrator.ts line 616: INSERT includes `(SELECT COALESCE(project_id, 1) ...)` |
| Offer-dispatch project_id | orchestrator.ts line 895: INSERT includes `(SELECT COALESCE(project_id, 1) ...)` |
| OfferProvider p_project_id | offer-provider.ts line 201: 4-param call to `fn_claim_work_offer` |
| Cubic worktree_path fix | orchestrator.ts line 491: `data.worktree_path ?? await selectExecutorWorktree(null)` |
| projects table extended | Migration 010 applied (db_name, git_root, etc.) |
| proposal.project_id | NOT NULL DEFAULT 1 with FK |
| fn_claim_work_offer | 4-param signature with p_project_id |

### Remaining Items (blocking AC-13775, AC-13778, AC-13804)
| Item | Evidence | Effort |
|------|----------|--------|
| Gate-reviewer project_id | orchestrator.ts line 1002: INSERT lacks project_id column | 15 min |
| Agent-spawner git_root | agent-spawner.ts line 26: hardcoded `WORKTREE_ROOT = "/data/code/worktree"` | 2-3 hours |
| Per-project pool routing | orchestrator uses metaPool for everything — correct for single-project, needs routing for multi-project | 2 hours |
| Backward compat E2E test | Not started | 1-2 hours |

## 3. Cost Tracking Gap

**CRITICAL: 124 dispatches produced ZERO spending_log rows.**

| Table | Rows for P300 |
|-------|---------------|
| squad_dispatch | 124 |
| spending_log | 0 |

The spawner dispatches agents via the offer pipeline, but no cost tracking hooks fire. This means:
- Token consumption for P300 is completely unknown
- Cannot calculate cost-per-AC or cost-per-phase
- Budget allocation in the previous token-tracker analysis ($10 total) is unverifiable

**Root cause:** The spending_log INSERT likely happens in the spawned agent's process, not in the orchestrator. If agents exit before writing cost data, it's lost. The `agent-spawner.ts` has no inline cost tracking.

**Recommendation:** Add a lightweight cost estimate to squad_dispatch metadata on completion, even if the agent doesn't report exact tokens.

## 4. Dependency Chain

```
P304 (REVIEW/new) ─── blocks ──→ P289 (DEVELOP/new, 7 ACs pending) ─── blocks ──→ P300 (DEVELOP/new)
                                                                 └── blocks ──→ P302 (DRAFT/new)
P297 (COMPLETE/mature) ─── blocks ──→ P302 (resolved)
```

**P289 is the critical path blocker.** All 7 ACs are pending. P289 must reach COMPLETE before P302 can advance past DRAFT.

P304 is in REVIEW/new — its advancement timeline is uncertain but it must clear before P289 can mature.

## 5. Remaining Work Estimate

| Task | Hours | Tokens (est.) | Model |
|------|-------|---------------|-------|
| Gate-reviewer project_id fix | 0.25 | 5K | xiaomi/mimo-v2-pro |
| Agent-spawner git_root | 2-3 | 40K-60K | xiaomi/mimo-v2-pro |
| Per-project pool routing | 2 | 30K-40K | xiaomi/mimo-v2-pro |
| Backward compat E2E | 1-2 | 20K-30K | xiaomi/mimo-v2-pro |
| **Total remaining** | **5.25-7.25h** | **95K-135K** | **~$0.19-0.27** |

## 6. Token Waste Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| No cost tracking | HIGH — flying blind on spending | Fix spawner cost hooks |
| 10 failed dispatches | MEDIUM — ~5 min wasted per failure | Investigate root causes (likely ENOENT in early runs) |
| Stale active dispatches | LOW — 3 active with no completed_at, ~3.5 min old | Normal for current run; cancel if >10 min |
| Repeated lease churn | LOW — 5 lease cycles on P300 in last 2h | Offer-expiry reaping working as designed |

## 7. Efficiency Score: 7/10

**Up from 6/10** — more implementation done than previously estimated. Key wins:
- PoolManager properly bootstrapped
- Both dispatch paths populate project_id
- Cubic worktree_path respected

Key concerns:
- Cost tracking completely broken (no visibility)
- Agent-spawner still zero-project-aware (hardcoded root)
- Gate path missing project_id (minor — can be DEFAULT 1 for now)

## 8. Recommendations

1. **Fix cost tracking immediately** — add spending_log hook in agent-spawner completion handler
2. **Gate-reviewer project_id** — trivial 15-min fix, do it now
3. **Agent-spawner project awareness** — highest-impact remaining item, 2-3h
4. **Do NOT advance P300 to Mature** until P289 clears — dependency chain must be respected
5. **Consider deferring per-project pool routing** — if all projects share the same DB for now, metaPool-only is sufficient. Full routing is Phase 2 work.

## 9. Verdict: PROCEED WITH CAUTION

Implementation is ahead of schedule (~65% vs 30% estimated). Two critical items remain:
- Fix gate-reviewer project_id (trivial)
- Wire agent-spawner to project git_root (substantial)

Cost tracking must be fixed before continuing — we cannot optimize what we cannot measure.
