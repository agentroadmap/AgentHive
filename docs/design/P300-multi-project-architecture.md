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

## 7. Research Gaps (from architectural review 2026-04-20)

### 7.1 squad_dispatch: Central vs Per-Project DB (DECIDED)

**Decision:** Keep `squad_dispatch` and `proposal_lease` in the DEFAULT project DB (`agenthive`). The offer/claim/lease pipeline is inherently cross-project coordination. Keeping it centralized avoids multi-DB polling.

**Architecture:**
- `metaPool` (always agenthive DB): squad_dispatch, proposal_lease, host_model_policy, model_routes, agent_registry, provider_registry
- `projectPools` (per-project DB): proposal, proposal_event, proposal_dependencies, workforce data, efficiency data

**Implication:** PoolManager needs two tiers — meta pool for cross-project coordination tables + per-project pools for project-specific data.

### 7.2 fn_claim_work_offer Signature Change

Current: `fn_claim_work_offer(p_agent_identity TEXT, p_required_capabilities TEXT[], p_lease_ttl_seconds INT)`

Add optional `p_project_id INT8 DEFAULT NULL`. When NULL, filter by agency's subscribed projects via provider_registry. When set, filter to that specific project. Non-breaking due to DEFAULT NULL.

### 7.3 MCP Tool Project Context

All MCP proposal/agent tools need optional `project_id` parameter. MCP server uses PoolManager internally to connect to the right DB. Default to project 1 for backward compat.

### 7.4 PoolManager Lifecycle

- `reapIdlePools(maxIdleMs: 300_000)` — close pools with no queries for 5 min
- Health check query on acquire: `SELECT 1`
- `drainPool(projectId)` on project deactivation (`is_active = false`)

### 7.5 Cross-Project Dependencies NOT Supported

Inter-project DAG dependencies are NOT supported in this proposal. Each project's dependency graph is independent. Cross-project deps deferred to P282 (federation).

### 7.6 Existing Worktree Migration

Default project (`id=1`) keeps `git_root = '/data/code/AgentHive'` and worktrees under `/data/code/worktree/`. No migration of existing worktrees needed — they stay at current paths.

## 8. Implementation Order (Revised)

Phase 1a (Migrations): extend projects table, add proposal.project_id with NOT NULL DEFAULT 1, backfill, update fn_claim_work_offer
Phase 1b (Code): PoolManager in pool.ts, orchestrator project-aware startup
Phase 2 (Routing): fn_claim update, offer-provider project filter, pipeline-cron, agent-spawner git_root
Phase 3 (Polish): Discord [PROJECT] prefix, MCP project_id parameter, E2E test
Phase 4 (Migration): migrate existing AgentHive as project_id=1, verify backward compat

### 7.7 Blast Radius & Failure Isolation

If project_A's DB is down, it must NOT block the orchestrator for project_B.

**Design:** Lazy pool creation means project_A's pool is only created when needed. If connection fails, the error is scoped to that project's work. Other project pools operate independently.

**Verification:** Simulate project_A DB down, verify project_B proposals still dispatch and complete.

### 7.8 Connection Limits

Postgres default `max_connections = 100`. With PoolManager:
- metaPool: 5 connections (default)
- Per-project pool: 5 connections each (configurable max)
- 10 projects × 5 = 50 + metaPool 5 = 55 total

Safe margin. Document in operational runbook.

### 7.9 Project Lifecycle

**Creation:** Manual SQL for now. INSERT into `roadmap_workforce.projects`, CREATE DATABASE for new project, run schema migrations.

**Deactivation:** Set `is_active = false`. Orchestrator drains existing work but stops dispatching new offers. Pool is reaped after idle timeout.

**Future:** MCP tool for project CRUD (Phase 3).

### 7.10 P300 / P302 Relationship

- P300 = architecture decisions + design (this proposal)
- P302 = TypeScript implementation of the design
- P300 should be reviewed and approved before P302 implementation begins
- P289 (provider_registry) must complete before P300 TypeScript work can start

## 8. Risks

| Risk | Mitigation |
|------|------------|
| Pool exhaustion (50+ projects) | Lazy creation, cap at 10, idle pool reaping |
| Wrong project DB connection | Pool key by project_id, fail fast on unknown |
| cubic-worktree disconnect | Fix: use cubic.worktree_path from acquire response |
| Gate-pipeline double connections | Each service has independent pool; total per-DB = 10 max |

## 9. Gate Issue Resolutions (2026-04-20)

The DRAFT→REVIEW gate (skeptic-alpha) held P300 with 6 issues. All addressed below.

### 9.1 Broken project_id Chain (FIXED)

**Problem:** The orchestrator's `handleStateChange()` INSERT into squad_dispatch (line 614) does NOT set `project_id`. It relies on DEFAULT 1. Same issue in `dispatchImplicitGate()` (line 896).

**Fix:** Both INSERTs must populate project_id from the proposal:
```sql
-- In handleStateChange, add subquery:
INSERT INTO roadmap_workforce.squad_dispatch
  (proposal_id, project_id, squad_name, dispatch_role, ...)
VALUES ($1,
  (SELECT project_id FROM roadmap_proposal.proposal WHERE id = $1),
  $2, $3, ...)
```

This ensures every dispatch inherits the proposal's project context. The existing DEFAULT 1 is a safety net, not the primary path.

### 9.2 Pool Bootstrap Gap (FIXED)

**Problem:** How does the orchestrator load project configs at startup? Singleton `getPool()` has no project awareness.

**Design:** Two-tier pool architecture:

```typescript
// pool.ts — add PoolManager alongside existing getPool()
class PoolManager {
  private metaPool: Pool;           // always connects to 'agenthive' DB
  private projectPools: Map<number, Pool> = new Map();

  constructor(metaPoolConfig: PoolConfig) {
    this.metaPool = new Pool(metaPoolConfig);
  }

  /** Cross-project coordination tables */
  getMetaPool(): Pool { return this.metaPool; }

  /** Per-project data tables (lazy, capped) */
  getProjectPool(projectId: number): Pool {
    if (this.projectPools.has(projectId)) {
      return this.projectPools.get(projectId)!;
    }
    if (this.projectPools.size >= 10) {
      throw new Error(`Pool cap reached (${this.projectPools.size}/10)`);
    }
    const config = this.loadProjectConfig(projectId);
    const pool = new Pool({ ...config, max: 5 });
    this.projectPools.set(projectId, pool);
    return pool;
  }

  private loadProjectConfig(projectId: number) {
    // Read from metaPool: SELECT * FROM projects WHERE id = $1
  }

  reapIdlePools(maxIdleMs = 300_000) { /* close unused pools */ }
  async healthCheck(projectId: number) { /* SELECT 1 */ }
  async drainPool(projectId: number) { /* pool.end() */ }
}
```

**Table routing:**
- `metaPool` (agenthive DB): `squad_dispatch`, `proposal_lease`, `host_model_policy`, `model_routes`, `agent_registry`, `provider_registry`, `projects`
- `projectPool` (per-project DB): `proposal`, `proposal_event`, proposal_dependencies, workforce data, efficiency data

**Why keep squad_dispatch in meta?** The offer/claim/lease pipeline is inherently cross-project. Agencies poll one table regardless of project. Moving it to per-project DBs would require multi-DB polling.

### 9.3 Proposal Creation Gap (FIXED)

**Problem:** When MCP tools create proposals, `project_id` defaults to 1. No way to specify project.

**Fix:** The `mcp_proposal(action: "create")` tool accepts optional `project_id` parameter. The INSERT uses the provided value (default 1 for backward compat):
```sql
INSERT INTO roadmap_proposal.proposal (..., project_id)
VALUES (..., COALESCE($project_id, 1))
```

This is a non-breaking change — existing callers don't need to pass project_id.

### 9.4 DB Creation Undocumented (FIXED)

**Problem:** The design says "one DB per project" but doesn't describe how to create the DB.

**Procedure:** Manual SQL for now (MCP tool in Phase 3):
```bash
# 1. Create the Postgres database
psql -h 127.0.0.1 -U admin -d agenthive -c "CREATE DATABASE project_alpha;"

# 2. Run schema migrations on the new DB
psql -h 127.0.0.1 -U admin -d project_alpha -f database/ddl/001_initial.sql
psql -h 127.0.0.1 -U admin -d project_alpha -f database/ddl/002_*.sql
# ... all migrations

# 3. Register in projects table (meta DB)
psql -h 127.0.0.1 -U admin -d agenthive -c "
INSERT INTO roadmap_workforce.projects (name, db_name, git_root, db_user, owner)
VALUES ('project_alpha', 'project_alpha', '/data/code/projects/alpha', 'xiaomi', 'xiaomi');
"

# 4. Grant DB access to the user
psql -h 127.0.0.1 -U admin -d project_alpha -c "
GRANT ALL ON SCHEMA roadmap, roadmap_proposal, roadmap_workforce, roadmap_efficiency TO xiaomi;
GRANT ALL ON ALL TABLES IN SCHEMA roadmap, roadmap_proposal, roadmap_workforce, roadmap_efficiency TO xiaomi;
"
```

The `db_create.sh` script (Phase 3) will automate steps 1-4.

### 9.5 Pool Math (FIXED)

**Problem:** Original calculation didn't account for gate-pipeline service as a separate consumer.

**Revised math:**
```
Per-DB connections:
  orchestrator pool:  max 5
  gate-pipeline pool: max 5
  CLI tools:          max 2 (ad-hoc)
  ─────────────────────────────
  Per-DB total:       max 12

For N projects:
  metaPool (agenthive): 12 connections (both services + CLI)
  Each project DB:      12 connections
  10 projects:          12 + (10 × 12) = 132

Postgres max_connections default: 100
```

**Resolution:** Reduce per-pool max from 5 to 3:
```
  orchestrator pool:  max 3
  gate-pipeline pool: max 3
  CLI tools:          max 2
  Per-DB total:       max 8
  10 projects:        8 + (10 × 8) = 88  ← safe under 100
```

If projects grow beyond 12, increase Postgres `max_connections` or use PgBouncer.

### 9.6 Cubic-Worktree Bug (FIXED)

**Problem:** `dispatchAgent()` at line 489 calls `selectExecutorWorktree(null)` — ignoring the `worktree_path` that `cubic_acquire()` returns. The cubic already knows its worktree but the orchestrator picks a different one.

**Evidence:** cubic_acquire returns `{ success, cubic_id, was_recycled, was_created, worktree_path }`. The orchestrator discards `worktree_path` and calls `selectExecutorWorktree(null)` which does filesystem scanning.

**Fix:** Use the cubic's worktree directly:
```typescript
// Before (bug):
const worktree = await selectExecutorWorktree(null);

// After (fix):
const worktree = data.worktree_path ?? await selectExecutorWorktree(null);
```

This is a prerequisite for multi-project: each project has different worktree roots, so the cubic (which knows the project) must supply the path.

## 10. Revised Acceptance Criteria

1. **DB schema:** `roadmap_workforce.projects` extended with `db_name`, `git_root`, `discord_channel_id`, `db_host`, `db_port`, `db_user` — **DONE** (migrations applied 2026-04-20)
2. **Proposal-project link:** `roadmap_proposal.proposal.project_id` column exists, NOT NULL DEFAULT 1 — **DONE**
3. **Pool manager:** Orchestrator uses PoolManager with metaPool + per-project pools (lazy, capped at 10, idle reaping at 5min)
4. **Agency scoping:** `fn_claim_work_offer` filters offers by agency's project subscriptions via `provider_registry` — **DONE** (p_project_id parameter added)
5. **squad_dispatch.project_id:** Populated from proposal's project_id on all new dispatches (handleStateChange + dispatchImplicitGate INSERTs)
6. **Git root:** Worktree paths use project's `git_root` instead of hardcoded WORKTREE_ROOT
7. **Cubic worktree:** dispatchAgent uses cubic_acquire's worktree_path instead of null
8. **DB creation:** Documented procedure (manual SQL; db_create.sh in Phase 3)
9. **Backward compat:** Single-project mode works unchanged (project_id=1, all existing data)
10. **Connection budget:** Per-pool max=3, total for 10 projects ≤ 88 connections under default Postgres limits
| P281 cubic-worktree disconnect | Fix as prerequisite — use cubic.worktree_path |
| Breaking existing deployments | project_id=1 default, all existing data backfilled |
