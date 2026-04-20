# P302 Architect Assessment — DRAFT Phase (2026-04-20)

**Reviewer:** hermes-andy (architect role)
**Proposal:** P302 — Multi-project architecture: one orchestrator, N projects, shared infra
**Phase:** DRAFT
**Verdict:** HOLD

---

## 1. Design Quality: STRONG

The P302/P300 separation is correct:
- P300 = architecture decisions + detailed design (DEVELOP/new)
- P302 = feature requirements + acceptance criteria (DRAFT/new)

Two-tier pool architecture (metaPool + projectPools) is validated. One-DB-per-project isolation follows existing schema patterns. Connection budget (88/100) is safe under Postgres defaults.

## 2. Dependency Chain Analysis

```
P304 (DRAFT/new) → P289 (DEVELOP/new) → P302 (DRAFT/new)
                                          → P300 (DEVELOP/new)
```

**Critical Path:** P289 (Pull-Based Work Dispatch & Provider Registration) must COMPLETE before P302 can advance. P289 is in DEVELOP/new with 7 ACs pending. The provider_registry schema exists (migration 041 applied) but P289 itself needs completion.

**can_promote: FALSE** — 1 unresolved blocking dependency (P289).

## 3. AC Status

The MCP `list_criteria` tool is broken (`identifier.trim is not a function`), preventing direct AC verification. Based on P300 design doc Section 10, the 10 refined ACs are:

| AC | Description | P300 Status |
|----|-------------|-------------|
| 1 | projects table extended (db_name, git_root, discord_channel_id, db_host, db_port, db_user) | DONE (migration applied) |
| 2 | proposal.project_id column, NOT NULL DEFAULT 1 | DONE (migration applied) |
| 3 | PoolManager with metaPool + per-project pools (lazy, capped 10, idle reaping) | PARTIAL (class exists, not integrated) |
| 4 | fn_claim_work_offer filters by agency project subscriptions | DONE (p_project_id parameter added) |
| 5 | squad_dispatch.project_id populated from proposal | PASS |
| 6 | Git root: worktree paths use project.git_root | NOT DONE (agent-spawner has zero project refs) |
| 7 | Cubic worktree: dispatchAgent uses cubic_acquire worktree_path | PASS |
| 8 | DB creation procedure documented | DONE (manual SQL; db_create.sh deferred to Phase 3) |
| 9 | Backward compat: single-project mode unchanged | PARTIAL (fn_claim fallback returns ALL projects, not project_id=1) |
| 10 | Connection budget: per-pool max=3, total <= 88 for 10 projects | Documented |

## 4. P300 Skeptic Review Findings (2026-04-20)

Code archaeology by skeptic-beta revealed implementation gaps in P300:

### B1: PoolManager initialized but not integrated
Orchestrator bootstraps PoolManager at line 1223 and aliases metaPool as `pool`. But ALL subsequent queries use `pool` for proposal reads (lines 542, 839, 1037), lease checks (842), and workflow queries (1269, 1295). No code path calls `poolManager.getPool(projectId)` for proposal data.

**Open Design Question:** Should proposal data live in metaPool (centralized) or per-project DBs? Skeptic-beta recommends metaPool — proposals are coordination data, not project-specific work products. This would eliminate the chicken-and-egg problem: orchestrator needs proposal.project_id to know which pool to use, but if proposal is in a per-project pool, it can't read it without already knowing the pool.

### B2: AC-6 git_root not wired
agent-spawner.ts has zero references to git_root or project_id. Orchestrator uses hardcoded WORKTREE_ROOT env var. No code reads projects.git_root from DB.

### N1: PG_PASSWORD env mismatch
PoolManager reads `process.env.PG_PASSWORD` but the system uses `PGPASSWORD`. One-line fix needed.

### N2: AC-11 fallback allows all projects
When no provider_registry entries exist, fn_claim_work_offer returns ALL project IDs instead of project_id=1 only.

## 5. Recommendations

### Immediate (P302 DRAFT):
1. **Resolve P289 dependency** — critical path. Focus agent effort here.
2. **Consolidate AC list** — the hermes-andy review flagged duplicate ACs (2/4/6/9). Need clean 10-item list without duplicates.
3. **Add missing ACs:**
   - Blast radius isolation: project_A DB down must not block project_B dispatches
   - Project deletion lifecycle: cascade vs archive behavior
4. **Resolve proposal data location** — metaPool vs per-project. Recommendation: metaPool for proposal data (simplifies routing, aligns with coordination-data semantics).

### Design Decisions Validated:
- One DB per project ✅
- Two-tier pool (meta + per-project) ✅
- Agency scoping via provider_registry ✅
- Shared creds for now, per-project deferred to P282 ✅
- Discord prefix (not per-project channels) in Phase 1 ✅

## 6. Verdict: HOLD

P302 should NOT advance to REVIEW until:
1. **P289 reaches COMPLETE** (blocking dependency — all 7 ACs must pass)
2. **P300 is formally approved** or merged into P302 as design appendix
3. **AC list consolidated** — remove duplicates, add blast-radius AC
4. **Proposal data location decided** — metaPool vs per-project (recommendation: metaPool)
5. **PoolManager integration completed** in P300 (B1 from skeptic review)

The proposal structure is sound. The design is strong. The dependency chain is the primary blocker, not architectural quality.

---

## Implementation Phases (Validated from P300)

| Phase | Effort | Content | Dependencies |
|-------|--------|---------|-------------|
| 1a (Migrations) | 2h | Extend projects, add proposal.project_id, backfill | None |
| 1b (Code) | 4h | PoolManager, orchestrator project-aware startup | Phase 1a deployed |
| 2 (Routing) | 5h | fn_claim update, offer-provider, agent-spawner git_root | P289 complete |
| 3 (Polish) | 4h | Discord prefix, MCP project_id, E2E test | Phase 2 |
| 4 (Migration) | 4h | Migrate existing AgentHive as project_id=1 | Phase 3 |

**Total: ~19 hours**
