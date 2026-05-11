# P193: Cubic Lifecycle Management — Ship Report

**Proposal:** P193  
**Title:** Cubic Lifecycle Management — concurrency limits, automatic cleanup, and recycling  
**Status:** COMPLETE  
**Ship Date:** 2026-05-04  
**Documented:** 2026-05-09

---

## Background

Prior to this work, 2,593+ stale cubics accumulated without any lifecycle enforcement. Every agent dispatch created a new cubic, consuming memory and worktree disk space indefinitely. This document describes the lifecycle management system that was delivered across P193 and its sibling P196.

### Relationship Between P193 and P196

P196 delivered the cleanup mechanics (idle detection, state tracking, cron), while P193 originally targeted configurable concurrency limits. In practice, the two proposals converged: the core lifecycle infrastructure shipped under P196's code footprint, and host-scoped concurrency budget checking landed in `CubicCleanupService`. Both proposals are now COMPLETE.

---

## Architecture: As-Built

### 1. `roadmap.cubic_state` — Lifecycle Shadow Table

Every row in `roadmap.cubics` gets a corresponding `cubic_state` row via the trigger `trg_cubic_state_init` on INSERT. This table tracks lifecycle independently of the operational `cubics` table.

**Lifecycle states:**

```
ACTIVE → IDLE → COMPLETED → STALE → ARCHIVED
```

| State | Meaning |
|-------|---------|
| `ACTIVE` | Cubic is in use (phase = RUNNING) |
| `IDLE` | No activity for >5 min, but not yet stale |
| `COMPLETED` | Agent finished its task |
| `STALE` | IDLE/COMPLETED for >30 min — eligible for cleanup |
| `ARCHIVED` | Terminal — expired and removed from active rotation |

**Sync relationship:** `cubic_state.lifecycle_status` is kept in sync with `cubics.status` via `CubicIdleDetector.syncFromCubics()`. This covers cubics that predate the `cubic_state` table.

---

### 2. `CubicIdleDetector`

**File:** `src/core/orchestration/cubic-idle-detector.ts`

Detects lifecycle transitions and writes state changes to `roadmap.cubic_state`.

| Constant | Value | Meaning |
|----------|-------|---------|
| `IDLE_TIMEOUT_MS` | 5 minutes | ACTIVE → IDLE transition threshold |
| `STALE_TIMEOUT_MS` | 30 minutes | IDLE/COMPLETED → stale (cleanup eligible) threshold |

**Key methods:**

| Method | Description |
|--------|-------------|
| `detectIdleCubics()` | Find ACTIVE cubics with `last_activity_at < now - 5min` and `phase != 'RUNNING'` |
| `detectStaleCubics()` | Find IDLE/COMPLETED cubics with `last_activity_at < now - 30min` |
| `markIdle(cubicId)` | Set `lifecycle_status = IDLE`, stamp `idle_since` |
| `markCompleted(cubicId)` | Set `lifecycle_status = COMPLETED` |
| `markArchived(cubicId)` | Set `lifecycle_status = ARCHIVED` (terminal) |
| `updateActivity(cubicId)` | Reset idle tracking: set `last_activity_at = NOW()`, `lifecycle_status = ACTIVE`, clear `idle_since` |
| `syncFromCubics()` | Reconcile `cubic_state` from `cubics.status` — returns count of rows updated |
| `getStats()` | GROUP BY `lifecycle_status` summary with oldest/newest activity timestamps |

Call `updateActivity()` on cubic focus, acquire, or any agent action to prevent false idle detection.

---

### 3. `CubicCleanupService`

**File:** `src/core/orchestration/cubic-cleanup.ts`

Handles expiry, worktree removal, orphan detection, and host-scoped concurrency budgets.

#### Standard Cleanup

| Method | Description |
|--------|-------------|
| `cleanupStaleCubics(options?)` | Full cleanup pass: detect stale → expire → archive → remove worktrees. Returns `CleanupReport`. |
| `expireCubic(cubicId)` | Mark `cubics.status = 'expired'`, set `cubic_state.lifecycle_status = 'ARCHIVED'`, release locks, write audit log |
| `removeWorktree(cubicId)` | Remove worktree at `cubics.worktree_path` (and legacy `/data/code/.claude/cubics/<id>`); non-fatal if path is missing |
| `syncCompletedCubics()` | Push `cubics.status = 'complete'` → `cubic_state.lifecycle_status = 'COMPLETED'` for drift repair |
| `markIdleCubics()` | Run idle detection loop and mark all detected cubics IDLE |
| `expireOldCubics(olderThanMinutes)` | Bulk-expire cubics older than threshold regardless of `cubic_state` (catches pre-lifecycle cubics) |

#### P526 Orphan Reaping

For cubics where registry state and worktree disk state have diverged:

| Method | Description |
|--------|-------------|
| `detectOrphanCubics(options?)` | Classify cubics into 4 orphan rules (see below) |
| `reapOrphanCubics(options?)` | Detect and apply preserve/delete/orphan actions. Returns `P526CleanupReport`. |
| `forceReapCubic(args)` | Manual override — bypass detection, force-reap a named cubic |

**Orphan classification rules:**

| Rule | Condition | Action |
|------|-----------|--------|
| 1 | Active registry, no live MCP agent slot, idle >5 min | Delete |
| 2 | Active registry, stale heartbeat, no MCP reference after 30 min | Delete |
| 3 | Closed registry (`complete`/`expired`), worktree still on disk after grace period | Delete worktree |
| 4 | Active registry, worktree missing, activated >grace-period ago | Mark `orphaned` |
| `force` | Manual operator override | Force-reap regardless of rule |

Dirty worktrees (uncommitted changes) are moved to `$AGENTHIVE_CUBIC_ORPHANS_ROOT` (default `/data/code/orphans`) rather than deleted. All reap actions are written to `roadmap.cubic_cleanup_audit`.

#### Host Concurrency Budget

```typescript
export const DEFAULT_MAX_ACTIVE_CUBICS_PER_HOST = 10;

checkCubicCreateBudget(options: CubicBudgetOptions): Promise<CubicBudgetStatus>
```

Reads `max_active_cubics_per_host` from `roadmap.host_model_policy.metadata` for the current host. Falls back to `DEFAULT_MAX_ACTIVE_CUBICS_PER_HOST = 10`. Returns `{ hostName, activeCount, maxActive, allowed }`. Use this as a pre-check before creating a new cubic.

Host name resolution: `AGENTHIVE_HOST` env var → `os.hostname()` fallback.

---

### 4. `fn_acquire_cubic()` — Atomic Acquire

**File:** `database/ddl/v4/007_cubic_acquire.sql`

Single SQL function that atomically find-or-creates and focuses a cubic on a proposal. Eliminates the 4-round-trip overhead of the previous MCP-based flow (16 round-trips for a 4-agent squad → 1 SQL call).

```sql
SELECT * FROM roadmap.fn_acquire_cubic(
    p_agent_identity  TEXT,
    p_proposal_id     INT8,
    p_phase           TEXT    DEFAULT 'design',
    p_budget_usd      NUMERIC DEFAULT NULL,
    p_worktree_path   TEXT    DEFAULT NULL
);
-- Returns: cubic_id, was_recycled, was_created, status, worktree_path
```

**Logic:**
1. Find existing cubic for `agent_identity` (prefer `idle`, then any non-expired)
2. If locked to a different proposal, set `was_recycled = TRUE` and release
3. Focus the cubic: `status = 'active'`, update `lock_holder`, `lock_phase`, `metadata`
4. If no cubic found: INSERT a new row with `was_created = TRUE`

**Index:** `idx_cubics_agent_active` on `(agent_identity, status) WHERE status NOT IN ('expired', 'complete')` supports the lookup in step 1.

---

### 5. `cubic-lifecycle-cron.ts` — Maintenance Cron

**File:** `scripts/cubic-lifecycle-cron.ts`

Runs every 15 minutes (or on-demand). Executes five steps in order:

```
Step 1: syncFromCubics()       — fix drift between cubics and cubic_state
Step 2: markIdleCubics()       — ACTIVE → IDLE after 5 min inactivity
Step 3: syncCompletedCubics()  — push complete status to cubic_state
Step 4: cleanupStaleCubics()   — expire and remove worktrees for IDLE/COMPLETED >30 min
Step 5: expireOldCubics(60)    — bulk-expire cubics >60 min old (skipped in dry-run)
```

**Crontab entry (every 15 minutes):**
```
*/15 * * * * cd /data/code/AgentHive && bun run scripts/cubic-lifecycle-cron.ts
```

**CLI flags:**
```
--dry-run              Report what would be cleaned without making changes
--no-worktree-cleanup  Skip worktree directory removal
```

---

## Production State (2026-05-04)

| Metric | Value |
|--------|-------|
| ACTIVE cubics | 16 |
| ARCHIVED cubics | 6,895 |
| Total | 6,911 |
| Cron interval | 15 min |
| Idle threshold | 5 min |
| Stale threshold | 30 min |
| Default max active / host | 10 |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/core/orchestration/cubic-idle-detector.ts` | Lifecycle state detection and transition writes |
| `src/core/orchestration/cubic-cleanup.ts` | Cleanup, expiry, orphan reaping, concurrency budget |
| `scripts/cubic-lifecycle-cron.ts` | 15-min maintenance cron |
| `database/ddl/v4/007_cubic_acquire.sql` | Atomic cubic acquire SQL function |

---

## Open Items

| Item | Notes |
|------|-------|
| Configurable idle/stale timeouts | Currently hardcoded constants in `CubicIdleDetector`. Original P193 plan was a `cubic_limits` table; actual implementation reads from `host_model_policy.metadata`. A dedicated config table remains an option if per-project timeout tuning is needed. |
| Gate pipeline capacity alerts | Original AC-8: alert on `alert_threshold` capacity. Not implemented — gate pipeline was retired (P754/P753). Capacity check is available via `checkCubicCreateBudget()` for integration into the dispatch path. |
| Orphan reaping in cron | `reapOrphanCubics()` exists but is not yet called from `cubic-lifecycle-cron.ts`. Must be added explicitly. |
