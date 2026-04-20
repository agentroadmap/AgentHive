# P300 Architectural Review — Multi-Project Architecture

**Reviewer:** hermes (architect)
**Date:** 2026-04-20
**Phase:** DRAFT → design gate
**Proposal:** P300

---

## 1. Design Assessment

The design doc at `docs/design/P300-multi-project-architecture.md` is solid. The core decisions are sound:

| Decision | Verdict | Rationale |
|----------|---------|-----------|
| One DB per project | ✅ Correct | Cleaner than schema-per-project. Matches Postgres conventions. Cross-project dblink is fine for rare queries. |
| Extend existing `projects` table | ✅ Correct | `roadmap_workforce.projects` exists; extending beats creating. |
| Lazy PoolManager | ✅ Correct | Avoids connection storm. Cap at 10 is reasonable. |
| Agency scoping via provider_registry | ✅ Correct | Reuses existing P289 registry. Natural join point. |
| Shared creds for now | ✅ Correct | P282 federation handles per-project creds. YAGNI applies. |
| Discord prefix not channels | ✅ Correct | Pragmatic phase 1. Channels come when project_count > 3. |

## 2. Research Gaps Found

### 2.1 Missing: `proposal.project_id` backward compatibility

The design says "all existing proposals get project_id = 1" but doesn't address:
- What happens to proposals already in DRAFT/REVIEW/DEVELOP that have active leases?
- Does `fn_claim_work_offer` need to handle NULL project_id (pre-migration rows)?
- The default `project_id = 1` works IF we first ensure `id=1` exists in projects table.

**Recommendation:** Migration should verify `projects(id=1)` exists before ALTER TABLE. Add COALESCE to all project-scoped queries: `COALESCE(p.project_id, 1)`.

### 2.2 Missing: PoolManager lifecycle and error handling

The design shows PoolManager creation but not:
- What happens when a project DB is unreachable? (pool connection error)
- How are idle pools reaped? (memory leak if 50 projects, 10 active, 40 idle pools)
- What happens on project deactivation? (`is_active = false` → drain pool?)

**Recommendation:** Add:
- `reapIdlePools(maxIdleMs: 300_000)` — close pools with no queries for 5 min
- Health check query per pool on acquire (SELECT 1)
- `drainPool(projectId)` on project deactivation

### 2.3 Missing: Transaction boundary for multi-project

When the orchestrator dispatches a gate agent for project A, which DB does it write to? The dispatch goes to `squad_dispatch` — but which database? The design assumes `squad_dispatch` stays in the default `agenthive` DB.

**Clarification needed:** Is `squad_dispatch` shared across projects (central queue) or per-project? The design says "orchestrator connects to the right DB based on project context" but `squad_dispatch` is the orchestrator's own tables. This is ambiguous.

**Recommendation:** `squad_dispatch` and `proposal_lease` should stay in the DEFAULT project DB (`agenthive`). The orchestrator reads from the central DB, writes dispatches there. Offer providers read from central DB. Per-project DBs hold only per-project proposal/workforce data. This matches the current architecture where the orchestrator has one pool.

### 2.4 Missing: Worktree path collision

If project A uses `/data/code/projects/alpha/worktrees/claude-andy` and project B uses `/data/code/projects/beta/worktrees/claude-andy`, there's no collision. But the current worktree root is `/data/code/worktree/<name>` — what happens to existing worktrees during migration?

**Recommendation:** Migration script should move existing worktrees under `/data/code/projects/agenthive/worktrees/` or keep the default project's git_root as `/data/code/AgentHive` so existing paths work unchanged.

### 2.5 Missing: fn_claim_work_offer filter details

The design proposes adding `sd.project_id IN (SELECT pr.project_id FROM provider_registry ...)` to the candidate CTE. But the current `fn_claim_work_offer` already has capability filtering — adding project filtering means the function signature changes.

Current signature (from 039 migration):
```sql
fn_claim_work_offer(p_agent_identity TEXT, p_required_capabilities TEXT[], p_lease_ttl_seconds INT)
```

Proposed change adds `p_project_id INT8 DEFAULT NULL`. This is a breaking change for callers unless default is NULL (no filter).

**Recommendation:** Make `p_project_id` optional (DEFAULT NULL). When NULL, filter by agency's subscribed projects. When set, filter to that specific project. This lets agencies opt into project-specific polling.

### 2.6 Risk not listed: Cross-project proposal dependencies

What if P301 (in project "web-ui") depends on P300 (in project "agenthive")? The DAG dependency engine currently assumes all proposals are in the same database. Cross-DB dependencies need dblink or a central dependency table.

**Recommendation:** Defer this to P282 (federation). For now, document that inter-project dependencies are NOT supported. Each project's DAG is independent.

### 2.7 Missing: MCP tool project context

Current MCP tools (`mcp_proposal`, `mcp_agent`) don't accept project_id. When you call `mcp_proposal(action: "list")`, which project's proposals do you see? The design doesn't address MCP tool routing.

**Recommendation:** Add optional `project_id` parameter to all MCP proposal/agent tools. Default to project 1. MCP server uses PoolManager internally to connect to the right DB.

## 3. Acceptance Criteria Review

The 8 AC are well-defined. Suggested refinements:

| AC | Gap | Fix |
|----|-----|-----|
| 1 (DB schema) | Missing: migration must create default project row if not exists | Add INSERT ... ON CONFLICT |
| 2 (Proposal link) | NULL vs DEFAULT 1 — prefer DEFAULT 1 for NOT NULL constraint | Use NOT NULL DEFAULT 1 |
| 3 (Pool manager) | Missing: idle reaping, health check, drain on deactivation | Add to AC or separate task |
| 4 (Agency scoping) | Missing: test that agency without project subscription sees no offers | Add E2E test |
| 5 (squad_dispatch) | Existing column may already have data — need backfill check | Add migration step |
| 6 (Git root) | Missing: migration of existing worktrees | Add to Phase 4 |
| 7 (Backward compat) | Good as stated | — |
| 8 (E2E) | Missing: what does "run independently" mean? Need concrete test | Define: "Two projects each with a DRAFT proposal can advance through REVIEW→DEVELOP independently" |

**Suggested additional AC:**
9. **Idle pool reaping:** Pools unused for 5+ minutes are closed and removed from memory
10. **MCP project context:** MCP proposal tools accept optional project_id parameter

## 4. Implementation Order Feedback

The 4-phase plan is logical. Suggested adjustment:

Phase 1 should be split:
- **1a:** Migration only (extend projects, add proposal.project_id, backfill)
- **1b:** PoolManager in pool.ts (code changes)

Phase 2 (Routing) depends on Phase 1a being deployed AND services restarted. Don't mix migrations and code in the same phase.

Phase 4 (Migration) should include:
- Create default project row (id=1, name='agenthive')
- Backfill proposal.project_id = 1 for all existing proposals
- Backfill squad_dispatch.project_id from proposal's project_id (if any data exists)
- Verify no orphaned proposals with NULL project_id

## 5. Dependencies Check

P300 has no hard dependencies blocking DRAFT→REVIEW. P299 and P298 are related (orchestrator migration, multi-provider) but not blocking — P300 can be designed independently and integrated later.

The design correctly notes P281 cubic-worktree disconnect as a prerequisite. Confirm this is fixed before P300 implementation begins.

## 6. Verdict

**READY for REVIEW.** The design is well-researched and the architecture is sound. The gaps identified above are addressable during review or as implementation notes. No fundamental architectural objections.

Key items to resolve before advancing to DEVELOP:
1. Clarify squad_dispatch location (central vs per-project DB)
2. Add MCP project_id parameter to design
3. Define E2E test for AC-8
4. Confirm P281 cubic-worktree disconnect is fixed

---

## File Reference

- Design: `docs/design/P300-multi-project-architecture.md`
- This review: `docs/design/P300-multi-project-review.md`
- Related migrations: `scripts/migrations/039-p281-claim-renew-reap-functions.sql`, `scripts/migrations/041-p289-agency-worker-separation.sql`
- Related code: `src/infra/postgres/pool.ts`, `src/core/pipeline/offer-provider.ts`, `src/core/orchestration/agent-spawner.ts`
