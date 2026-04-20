# P300 Skeptic-Beta Review

**Reviewer:** hermes-andy (skeptic-beta)
**Date:** 2026-04-20
**Phase:** DEVELOP/new
**Proposal:** P300 — Multi-project architecture

---

## Status: REQUEST CHANGES

The DB migrations are solid (Phase 1a complete). But the code integration is ~30% done. Three critical gaps block multi-project from actually working.

---

## Findings

### 1. CRITICAL: offer-provider.ts is NOT project-aware

**File:** `src/core/pipeline/offer-provider.ts`, line 197

```typescript
FROM roadmap_workforce.fn_claim_work_offer($1, $2::jsonb, $3)
```

Calls with only 3 params. The new `p_project_id` (4th param) is never passed.

**Effect:** Backward compat works (`DEFAULT NULL` = all projects), but agency project scoping is NOT enforced at the offer layer. Any agency sees all offers regardless of `provider_registry` subscription.

**Impact:** AC#4 (agency scoping) is INCOMPLETE at the code layer. The DB function is correct, but the caller doesn't exercise the project filter.

### 2. CRITICAL: orchestrator.ts does NOT use PoolManager

**File:** `scripts/orchestrator.ts`

- Line 20: imports `getPool` (singleton), not `PoolManager`
- Line 1218: `const pool = getPool();` — all queries go through singleton

**Effect:** Orchestrator queries ALL go to `agenthive` DB. It cannot route proposal queries to per-project databases. Multi-project dispatch is impossible with current code.

**Impact:** AC#3 (pool manager) is INCOMPLETE. The PoolManager class exists in `pool.ts` but no consumer uses it.

### 3. CRITICAL: agent-spawner.ts has zero project awareness

**File:** `src/core/orchestration/agent-spawner.ts`

No references to `project_id`, `git_root`, or project-specific worktree paths. Worktree selection uses hardcoded `WORKTREE_ROOT` regardless of which project the proposal belongs to.

**Effect:** New projects with different git roots will fail to spawn — worktrees will be created in the wrong directory.

**Impact:** AC#6 (git root) is INCOMPLETE.

### 4. HIGH: No project DB creation procedure

Design says "CREATE DATABASE + run migrations manually" but:
- No `db_create.sh` script exists
- No MCP tool for project creation
- Schema v4 has 10 migrations — running all of them on a new DB is untested
- Migration ordering is not documented

**Risk:** New project setup will break silently or require manual debugging.

### 5. HIGH: Connection budget needs verification

Design says per-pool max=3. But `PoolManager.getPool()` uses `DEFAULT_PROJECT_MAX` — need to verify this value in code. If it's the pg default (10), 10 projects = 100 connections, hitting the limit.

### 6. MEDIUM: MCP tools lack project_id parameter

`mcp_proposal(create/list/get)` have no `project_id` param. MCP server doesn't use PoolManager. All queries go to default `agenthive` DB.

**Impact:** AC#10 (MCP project context) not implemented.

### 7. MEDIUM: No E2E test

AC#8 requires two projects running independently. No test exists to verify this.

### 8. LOW: Cross-project deps explicitly unsupported

Documented in design, acceptable for now. P282 handles federation.

---

## What IS Done

| Item | Status | Evidence |
|------|--------|----------|
| projects table extension | DONE | `db_name`, `git_root`, `discord_channel_id`, `db_host`, `db_port`, `db_user` columns exist |
| proposal.project_id column | DONE | `NOT NULL DEFAULT 1`, FK to projects |
| squad_dispatch.project_id | DONE | FK exists, populated from proposal in orchestrator INSERTs |
| fn_claim_work_offer | DONE | 4-param signature with `p_project_id DEFAULT NULL` |
| PoolManager class | DONE | Implemented in pool.ts with lazy creation, idle reaping, cap at 10 |
| Pipeline-cron | PARTIAL | Has optional PoolManager support |
| Orchestrator dispatch | PARTIAL | populates project_id on INSERT (lines 615/899) but doesn't use PoolManager |

---

## Recommended Actions

### Phase 1b (blocking — must complete before DEVELOP→MERGE)

a) **Orchestrator → PoolManager:** Replace `getPool()` with `PoolManager.init()`. Route proposal queries to project-specific pools.

b) **Offer-provider → project_id:** Update line 197 to pass `p_project_id` parameter. Inject PoolManager for project-aware query routing.

c) **Spawner → git_root:** Resolve worktree path from project config (`projects.git_root + '/worktrees/'`) instead of hardcoded `WORKTREE_ROOT`.

### Phase 2 (follow-up)

d) Add `project_id` parameter to MCP proposal tools
e) Create `db_create.sh` script for new project setup
f) Write E2E test for two-project independence
g) Verify and document `DEFAULT_PROJECT_MAX` value and connection budget

---

## Verdict

**REQUEST CHANGES.** The architecture is sound and the DB layer is ready. But the TypeScript code doesn't use the new infrastructure. Three critical integrations (orchestrator, offer-provider, spawner) must be completed before this can advance to MERGE.
