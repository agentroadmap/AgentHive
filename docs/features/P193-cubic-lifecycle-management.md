# P193 — Cubic Lifecycle Management: Ship Report

**Proposal:** P193 — Cubic Lifecycle Management (concurrency limits, automatic cleanup, recycling)
**Status:** COMPLETE
**Ship Date:** 2026-05-12
**Core delivery:** P196 (lifecycle tables + cron + cleanup services)
**Extended delivery:** P526 (orphan detection and reaping)

---

## 1. Purpose

This document is the agent onboarding reference for the cubic lifecycle system. It records what was actually built, what tables and services are live, the partial gap in configurable limits, and the production state as of 2026-05-04.

---

## 2. What Shipped

### 2.1 Database Layer

**`roadmap.cubic_state`** — lifecycle shadow table, auto-created per cubic via trigger `trg_cubic_state_init` on `roadmap.cubics INSERT`.

| Column | Type | Notes |
|--------|------|-------|
| `cubic_id` | text | FK → `roadmap.cubics(cubic_id) ON DELETE CASCADE` |
| `lifecycle_status` | text | `ACTIVE` \| `IDLE` \| `COMPLETED` \| `STALE` \| `ARCHIVED` |
| `phase` | text | mirrors `cubics.phase` |
| `last_activity_at` | timestamptz | updated on every agent action |
| `idle_since` | timestamptz | set when status transitions to IDLE |

**Schema note:** The original P193 ACs referenced `roadmap.cubic_lifecycle` (not real) and `roadmap.cubic_limits` (not yet created). The live table is `roadmap.cubic_state`. Do not reference `cubic_lifecycle` in new code.

**`roadmap.fn_acquire_cubic()`** — atomic cubic acquisition function (`database/ddl/v4/007_cubic_acquire.sql`).

Signature:
```sql
roadmap.fn_acquire_cubic(
  p_agent_identity TEXT,
  p_proposal_id    INT8,
  p_phase          TEXT DEFAULT 'design',
  p_budget_usd     NUMERIC DEFAULT NULL,
  p_worktree_path  TEXT DEFAULT NULL
) RETURNS TABLE (cubic_id TEXT, was_recycled BOOLEAN, was_created BOOLEAN, status TEXT, worktree_path TEXT)
```

Behaviour (single transaction):
1. Find existing cubic for agent (prefer IDLE, then any non-expired).
2. If locked to a different proposal, mark `was_recycled = TRUE` and release.
3. Focus the cubic: set `status = active`, `lock_holder = 'P' || proposal_id`.
4. If no cubic exists, INSERT and return `was_created = TRUE`.

Supporting index: `idx_cubics_agent_active ON roadmap.cubics(agent_identity, status) WHERE status NOT IN ('expired', 'complete')`.

### 2.2 Services

**`CubicIdleDetector`** (`src/core/orchestration/cubic-idle-detector.ts`)

| Method | Description |
|--------|-------------|
| `detectIdleCubics()` | Returns ACTIVE cubics with no activity for ≥ 5 min and `phase != RUNNING` |
| `detectStaleCubics()` | Returns IDLE/COMPLETED cubics with no activity for ≥ 30 min |
| `markIdle(cubicId)` | Transitions to IDLE, sets `idle_since` |
| `markCompleted(cubicId)` | Transitions to COMPLETED |
| `markArchived(cubicId)` | Transitions to ARCHIVED (terminal) |
| `updateActivity(cubicId)` | Resets `last_activity_at`, clears `idle_since`, sets ACTIVE/RUNNING |
| `syncFromCubics()` | Repairs drift between `cubics.status` and `cubic_state.lifecycle_status` |
| `getStats()` | Returns counts grouped by `lifecycle_status` |

Hardcoded thresholds: `IDLE_TIMEOUT_MS = 5 min`, `STALE_TIMEOUT_MS = 30 min`. These are class-level constants — not yet driven by config table (see §4).

**`CubicCleanupService`** (`src/core/orchestration/cubic-cleanup.ts`)

Core cleanup methods:

| Method | Description |
|--------|-------------|
| `cleanupStaleCubics(opts)` | Full run: detect stale → expire → archive → optionally remove worktrees |
| `expireCubic(cubicId)` | Sets `cubics.status = 'expired'`, archives `cubic_state`, releases locks, writes `audit_log` |
| `removeWorktree(cubicId)` | Removes worktree dir from `cubics.worktree_path` or legacy path |
| `markIdleCubics()` | Drives `CubicIdleDetector.markIdle()` for all detected idle cubics |
| `syncCompletedCubics()` | Syncs `cubics.status = 'complete'` → `cubic_state.lifecycle_status = 'COMPLETED'` |
| `expireOldCubics(minutes)` | Bulk-expires cubics older than N minutes (catches pre-`cubic_state` rows) |

P526 orphan-reap extensions:

| Method | Description |
|--------|-------------|
| `detectOrphanCubics(opts)` | Classifies candidates by 4 orphan rules (see §3) |
| `reapOrphanCubics(opts)` | Applies preserve/delete/orphan actions; returns `P526CleanupReport` |
| `forceReapCubic(args)` | Manual override — bypasses classification, force-reaps a named cubic |

**Worktree cleanup:** Cleans both `cubics.worktree_path` and the legacy path `/data/code/.claude/cubics/<cubic-id>`.

**Orphans root:** `AGENTHIVE_CUBIC_ORPHANS_ROOT` env var, defaults to `/data/code/orphans`. Dirty worktrees are moved here (not deleted) before the registry entry is purged.

### 2.3 Cron Job

**`scripts/cubic-lifecycle-cron.ts`** — runs every 15 minutes via crontab.

Five steps per run:
1. `detector.syncFromCubics()` — fix drift between `cubics` and `cubic_state`
2. `cleanup.markIdleCubics()` — ACTIVE → IDLE after 5 min inactivity
3. `cleanup.syncCompletedCubics()` — sync COMPLETED status
4. `cleanup.cleanupStaleCubics()` — expire IDLE/COMPLETED cubics stale ≥ 30 min
5. `cleanup.expireOldCubics(60)` — expire any cubics older than 60 min (catch-all)

Flags: `--dry-run` (steps 4+5 skipped), `--no-worktree-cleanup` (worktree removal skipped).

---

## 3. Orphan Classification Rules (P526)

`detectOrphanCubics()` classifies each candidate against four rules (checked in priority order):

| Rule | Condition | Action |
|------|-----------|--------|
| 4 | Active registry, no worktree on disk (grace period elapsed) | `ORPHANED` — set `status = orphaned`, release locks |
| 3 | Closed (complete/expired) registry, worktree still on disk | `DELETED` — remove worktree, delete registry row |
| 2 | Active, stale heartbeat, no active MCP reference | `DELETED` or `PRESERVED` if dirty |
| 1 | Active, no active MCP agent slot for `cubic_id:agent_identity` | `DELETED` or `PRESERVED` if dirty |

Dirty worktrees (uncommitted changes) are always moved to `$AGENTHIVE_CUBIC_ORPHANS_ROOT/<cubic-id>-<timestamp>` instead of deleted, and the registry row is set to `status = orphaned` with `worktree_path` updated to the recovery path.

---

## 4. Configurable Limits — Partial Implementation

The original P193 design called for a `roadmap.cubic_limits` config table and a `CubicLimitsService.isAtCapacity()` gate. **This table was not created.**

What was implemented instead: `checkCubicCreateBudget()` in `cubic-cleanup.ts` reads `max_active_cubics_per_host` from `roadmap.host_model_policy.metadata` (JSON key). Default is 10 (`DEFAULT_MAX_ACTIVE_CUBICS_PER_HOST`).

```typescript
// Reads from host_model_policy.metadata->>'max_active_cubics_per_host'
const status: CubicBudgetStatus = await checkCubicCreateBudget({ query });
if (!status.allowed) { /* block creation */ }
```

The MCP `cubic_create` handler calls this before inserting. This covers the core gate but does not provide:
- A dedicated `cubic_limits` config table with `alert_threshold`, `ttl_hours`, or `idle_timeout_minutes` config keys.
- Operator UI or MCP tools to update limits without touching `host_model_policy`.
- The `cubic.check_and_alert()` gate-pipeline integration originally specified in P193.

These remain as a potential follow-on proposal if dynamic limit management is needed.

---

## 5. Production State (2026-05-04)

| Metric | Value |
|--------|-------|
| `cubic_state` ACTIVE | 16 |
| `cubic_state` ARCHIVED | 6,895 |
| Cron cadence | Every 15 min |
| Idle threshold | 5 min (hardcoded) |
| Stale threshold | 30 min (hardcoded) |
| Default max active per host | 10 (host_model_policy or constant) |

---

## 6. Code Artifacts

| Artifact | Path |
|----------|------|
| Lifecycle shadow table DDL | Shipped in P196 (see `database/ddl/v4/007_cubic_acquire.sql` for fn + index) |
| Atomic acquire function | `database/ddl/v4/007_cubic_acquire.sql` |
| Idle detector | `src/core/orchestration/cubic-idle-detector.ts` |
| Cleanup service | `src/core/orchestration/cubic-cleanup.ts` |
| Lifecycle cron | `scripts/cubic-lifecycle-cron.ts` |
| MCP cubic tools | `src/apps/mcp-server/tools/cubic/` |
| Orphan cleanup tests | `tests/cubic/cubic-cleanup-p526.test.ts` |

---

## 7. AC Status

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | `cubic_state` table created with lifecycle columns | PASS (via P196) |
| AC-2 | Trigger auto-creates `cubic_state` row on `cubics` insert | PASS (via P196) |
| AC-3 | Cron marks IDLE after inactivity threshold | PASS (5 min constant) |
| AC-4 | Cron expires STALE cubics after stale threshold | PASS (30 min constant) |
| AC-5 | `fn_acquire_cubic` recycles idle cubics atomically | PASS (via P196) |
| AC-6 | Worktree removal on expiry | PASS |
| AC-7 | Audit log entries for cleanup actions | PASS (`cubic_cleanup_audit` table) |
| AC-8 | Configurable limits table with `max_concurrent` | PARTIAL — limit is in `host_model_policy.metadata`, not a dedicated `cubic_limits` table |

---

## 8. Related Proposals

- **P196** — cubic_state table + trigger + fn_acquire_cubic + cleanup services (core delivery)
- **P201** — roadmap.cubics table schema (prerequisite)
- **P526** — cubic orphan detection and reaping (extended cleanup rules)
- **P193 gap** — `roadmap.cubic_limits` config table + `CubicLimitsService` (not built; limits served from `host_model_policy.metadata`)
