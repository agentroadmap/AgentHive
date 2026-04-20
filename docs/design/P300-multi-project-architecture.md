# P300 Design: Multi-Project Architecture

> One orchestrator, N projects, shared infrastructure.

**Proposal:** P300
**Phase:** DRAFT → design
**Date:** 2026-04-20

---

## 1. Current State (Single-Project Assumptions)

| Component | Current | Problem |
|-----------|---------|---------|
| DB pool | Singleton `getPool()` via `pool.ts` | Single DATABASE_URL, no project awareness |
| Git root | Hardcoded `/data/code/AgentHive` | All projects share one repo |
| Worktree root | Env `AGENTHIVE_WORKTREE_ROOT` default `/data/code/worktree` | No per-project isolation |
| Projects table | `roadmap_workforce.projects` (id, name, description, owner, is_active) | Missing db_name, git_root, discord_channel_id |
| Proposal | No `project_id` column | Can't associate proposals with projects |
| squad_dispatch | Has `project_id` column (already!) | Not populated, not filtered |
| fn_claim_work_offer | No project_id filter | Any agency claims any offer |
| Discord routing | Single channel | No project context |

## 2. Design Decisions

### 2.1 One Database Per Project

Each project gets its own Postgres database on the shared instance:
```
agenthive          → default project (project_id=1)
project_alpha      → separate DB
project_beta       → separate DB
```

Each DB has the same schema set: `roadmap`, `roadmap_proposal`, `roadmap_workforce`, `roadmap_efficiency`.

Cross-project queries are rare. Use dblink or application-level joins when needed.

**Why not schema-per-project?** Schema isolation within one DB leaks: search_path confusion, accidental cross-project queries, harder to grant per-project DB access. Separate databases are cleaner.

### 2.2 Project Registry (extend existing table)

Add columns to `roadmap_workforce.projects`:

```sql
ALTER TABLE roadmap_workforce.projects
  ADD COLUMN db_name TEXT NOT NULL DEFAULT 'agenthive',
  ADD COLUMN git_root TEXT NOT NULL DEFAULT '/data/code/AgentHive',
  ADD COLUMN discord_channel_id TEXT,
  ADD COLUMN db_host TEXT NOT NULL DEFAULT '127.0.0.1',
  ADD COLUMN db_port INT NOT NULL DEFAULT 5432,
  ADD COLUMN db_user TEXT NOT NULL DEFAULT 'xiaomi';
```

The orchestrator reads this table at startup to discover projects.

### 2.3 Orchestrator: Pool Manager

Replace the singleton `getPool()` pattern with a `PoolManager`:

```typescript
class PoolManager {
  private pools: Map<number, Pool> = new Map();
  private projects: Map<number, ProjectConfig> = new Map();

  async loadProjects(): Promise<void> {
    // Read from default pool first
    const rows = await defaultPool.query(
      'SELECT * FROM roadmap_workforce.projects WHERE is_active = true'
    );
    for (const row of rows.rows) {
      this.projects.set(row.id, row);
    }
  }

  getPool(projectId: number): Pool {
    if (!this.pools.has(projectId)) {
      const config = this.projects.get(projectId);
      if (!config) throw new Error(`Unknown project ${projectId}`);
      const pool = new Pool({
        host: config.db_host,
        port: config.db_port,
        database: config.db_name,
        user: config.db_user,
        max: 5, // small pool per project
      });
      this.pools.set(projectId, pool);
    }
    return this.pools.get(projectId)!;
  }
}
```

**Lazy creation:** Pools created on first use, not at startup. Prevents 50-project connection storms.
**Cap:** Max 10 active pools (configurable).

### 2.4 Proposal → Project Association

Add `project_id` to proposal table:

```sql
ALTER TABLE roadmap_proposal.proposal
  ADD COLUMN project_id INT8 REFERENCES roadmap_workforce.projects(id) DEFAULT 1;
```

All existing proposals get `project_id = 1` (the default agenthive project).

### 2.5 Agency Project Scoping

Modify `fn_claim_work_offer` to filter by project subscription:

```sql
-- Add project_id filter to candidate CTE
candidate AS (
  SELECT sd.id
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.offer_status = 'open'
    -- NEW: only offer work for projects this agency has joined
    AND sd.project_id IN (
      SELECT pr.project_id
      FROM roadmap_workforce.provider_registry pr
      WHERE pr.agency_id = (SELECT id FROM agent_registry WHERE agent_identity = p_agent_identity)
        AND pr.is_active = true
    )
    -- existing capability check...
)
```

Also add `p_project_id` parameter (optional) to allow callers to request a specific project's offers.

### 2.6 Git Root Per Project

The spawner and cubic_acquire need project-aware worktree paths:

```
Default: /data/code/AgentHive → /data/code/worktree/
Project A: /data/code/projects/alpha/git/ → /data/code/projects/alpha/worktrees/
```

`fn_acquire_cubic` already accepts `p_worktree_path`. The orchestrator passes the project's git_root + `/worktrees/` + branch-slug.

### 2.7 Discord Routing

Phase 1 (this proposal): Shared channel with `[PROJECT_NAME]` prefix on all notifications.
Phase 2 (future): Per-project channels via `projects.discord_channel_id`.

### 2.8 Credential Model

No changes. All projects share `/home/xiaomi` creds. Per-project credential overrides deferred until P282 federation.

## 3. Files Requiring Changes

| File | Change |
|------|--------|
| `src/infra/postgres/pool.ts` | Add PoolManager class, extend getPool() to accept project_id |
| `scripts/orchestrator.ts` | Load projects at startup, pass project_id to dispatchers |
| `src/core/orchestration/agent-spawner.ts` | Accept project_id, resolve git_root from DB |
| `database/ddl/` (new migration) | Extend projects table, add proposal.project_id |
| `database/ddl/` (new migration) | Update fn_claim_work_offer with project filter |
| `src/core/pipeline/reap-stale-rows.ts` | Iterate over all project pools |

## 4. Acceptance Criteria (Refined)

1. **DB schema:** `roadmap_workforce.projects` extended with `db_name`, `git_root`, `discord_channel_id`, `db_host`, `db_port`, `db_user`
2. **Proposal-project link:** `roadmap_proposal.proposal.project_id` column exists, defaults to 1
3. **Pool manager:** Orchestrator creates per-project pg.Pool (lazy, capped at 10)
4. **Agency scoping:** `fn_claim_work_offer` filters offers by agency's project subscriptions via `provider_registry`
5. **squad_dispatch.project_id:** Populated from proposal's project_id on all new dispatches
6. **Git root:** Worktree paths use project's `git_root` instead of hardcoded path
7. **Backward compat:** Single-project mode works unchanged (project_id=1, all existing data)
8. **End-to-end:** Two projects can run independently with separate DBs, git roots, and offer pipelines

## 5. Implementation Order

1. Migration: extend projects table (columns)
2. Migration: add proposal.project_id, backfill to 1
3. Migration: update fn_claim_work_offer (project filter)
4. Pool manager in pool.ts
5. Orchestrator: project-aware dispatch
6. Spawner: project-aware worktree paths
7. Gateway: [PROJECT] prefix in Discord notifications
8. E2E test with two projects

## 6. Risks

| Risk | Mitigation |
|------|------------|
| Pool exhaustion (50+ projects) | Lazy creation, cap at 10, idle pool reaping |
| Wrong project DB connection | Pool key by project_id, fail fast on unknown |
| P281 cubic-worktree disconnect | Fix as prerequisite — use cubic.worktree_path |
| Breaking existing deployments | project_id=1 default, all existing data backfilled |
