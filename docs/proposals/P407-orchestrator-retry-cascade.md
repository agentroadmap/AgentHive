# P407 — Orchestrator Retry Cascade: SPAWN_POLICY_VIOLATION + AGENT_DEAD Escalation Storm

## Status: DRAFT → MATURE | Type: issue | Agent: architect

## Problem Statement

The orchestrator creates escalating volumes of `SPAWN_POLICY_VIOLATION` (10,632) and `AGENT_DEAD` (38) escalations because:

1. **`selectExecutorWorktree` throws instead of returning null** — When all worktrees are policy-forbidden or unusable, the function throws at `orchestrator.ts:667` instead of returning null. Every caller must catch this error, and unhandled throws propagate up the dispatch loop, causing repeated failures on each poll cycle (~30s).

2. **No circuit breaker stops retrying proposals that consistently fail spawn policy** — The orchestrator dispatch loop has no mechanism to detect that a proposal has failed spawn policy N times in a row and should be temporarily skipped. Every poll cycle re-attempts dispatch, generating a new violation escalation each time.

3. **No deduplication prevents duplicate escalations for identical violations** — `assertSpawnAllowed` in `agent-spawner.ts:373-407` unconditionally INSERTs into `escalation_log` and throws `SpawnPolicyViolation`. Within minutes, thousands of identical rows accumulate because the orchestrator retries the same (host, provider) violation every ~30 seconds.

4. **`hermes/agency-xiaomi` registered in `agent_registry` but may lack worktree on disk** — If the agent is registered but its worktree directory doesn't exist under `WORKTREE_ROOT`, `scoreUsableWorktree` returns null, and the entry is silently skipped. If it IS the only registered agent and all others are also unusable, the loop hits the throw at line 667.

## Code Audit — Corrected Implementation Status

### What actually exists vs what was claimed:

| Component | Claimed Status | Actual Status | Evidence |
|:---|:---|:---|:---|
| `selectExecutorWorktree` returns null | "Implemented (line 470-475)" | **NOT IMPLEMENTED** | `orchestrator.ts:667` still throws `Error("No usable executor worktree found...")` |
| Circuit breaker Map | "Implemented (lines 49-75)" | **NOT IMPLEMENTED** | Lines 49-75 contain `STATE_TO_PHASE` mapping. No circuit breaker code exists anywhere in orchestrator.ts. |
| Circuit breaker checks at dispatch (line 540) and implicit gate (line 886) | "Implemented" | **NOT IMPLEMENTED** | Line 540 is `readString()` utility. Line 886 is `ensureAgentIdentity()`. No spawn-blocking logic exists. |
| Escalation dedup Map in assertSpawnAllowed (lines 303-371) | "Implemented" | **NOT IMPLEMENTED** | Lines 303-371 contain `buildOpenAICompatArgs`, `buildGeminiArgs`, `buildArgsBySpec`. `assertSpawnAllowed` at lines 373-407 always INSERTs unconditionally. |

### What IS implemented correctly:
- `scoreUsableWorktree()` at `orchestrator.ts:572-613` correctly returns null for unusable worktrees (missing dir, no .env.agent, no write access)
- `selectExecutorWorktree()` at `orchestrator.ts:615-679` correctly deduplicates candidates and ranks by score — **but throws on empty result instead of returning null**
- The dispatch loop at line 875-883 uses `Promise.allSettled` so individual dispatch failures don't crash the loop — but they do generate repeated escalations

## Design

### Fix 1: `selectExecutorWorktree` — return null instead of throwing

**File:** `scripts/orchestrator.ts`
**Location:** Line 666-669

**Change:** Replace the `throw` with `return null`.

```typescript
// BEFORE (line 666-669):
if (!ranked.length) {
    throw new Error(
        `No usable executor worktree found under ${WORKTREE_ROOT}...`
    );
}

// AFTER:
if (!ranked.length) {
    logger.warn(`No usable executor worktree found; dispatch will be skipped this cycle`);
    return null;
}
```

**Signature change:** Return type becomes `Promise<string | null>` (currently `Promise<string>`).

**Caller changes required:**

```typescript
// Line 1126 (implicit gate dispatch) — add after selectExecutorWorktree call:
const worktree = await selectExecutorWorktree(null);
if (!worktree) {
    logger.warn(`Implicit gate for ${proposal.display_id}: no usable worktree, skipping dispatch`);
    return;
}

// Line 1370 (transition_queue dispatch) — add after selectExecutorWorktree call:
const worktree = await selectExecutorWorktree(requestedWorktree);
if (!worktree) {
    logger.warn(`Transition dispatch for ${transition.display_id}: no usable worktree, skipping`);
    await query(`UPDATE roadmap.transition_queue SET status = 'blocked', updated_at = now() WHERE id = $1`, [transition.id]);
    return;
}
```

### Fix 2: Circuit breaker — in-memory spawn violation tracker

**File:** `scripts/orchestrator.ts`
**Location:** New code near top of file (after imports)

**Design:**
```typescript
// Circuit breaker: track spawn policy violations per (proposal_id, agent) pair.
// After threshold violations within window, skip dispatch for that pair.
const SPAWN_CIRCUIT_BREAKER_THRESHOLD = 3;
const SPAWN_CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const spawnViolationTracker = new Map<string, { count: number; firstAt: number }>();

function spawnCircuitKey(proposalId: number, agent: string): string {
    return `${proposalId}:${agent}`;
}

function recordSpawnViolation(proposalId: number, agent: string): boolean {
    const key = spawnCircuitKey(proposalId, agent);
    const now = Date.now();
    const entry = spawnViolationTracker.get(key);

    if (!entry || now - entry.firstAt > SPAWN_CIRCUIT_BREAKER_WINDOW_MS) {
        spawnViolationTracker.set(key, { count: 1, firstAt: now });
        return false; // not yet blocked
    }

    entry.count++;
    if (entry.count >= SPAWN_CIRCUIT_BREAKER_THRESHOLD) {
        logger.warn(`Circuit breaker tripped for ${key} (${entry.count} violations in window)`);
        return true; // blocked
    }
    return false;
}

function isSpawnBlocked(proposalId: number, agent: string): boolean {
    const key = spawnCircuitKey(proposalId, agent);
    const entry = spawnViolationTracker.get(key);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > SPAWN_CIRCUIT_BREAKER_WINDOW_MS) {
        spawnViolationTracker.delete(key);
        return false;
    }
    return entry.count >= SPAWN_CIRCUIT_BREAKER_THRESHOLD;
}
```

**Integration points (3 dispatch paths):**

1. **`dispatchAgent()` (line 704)** — Add `isSpawnBlocked(proposalId)` check after `cubic_acquire` succeeds but before `selectExecutorWorktree` loop. If blocked, release cubic and return null. On `SpawnPolicyViolation` catch (line 805), call `recordSpawnViolation(proposalId)`.

2. **Implicit gate dispatch (`dispatchImplicitGate`, line 1126)** — Add `isSpawnBlocked(proposal.id)` check before `selectExecutorWorktree(null)`. If blocked, return early. The existing try/catch at line 1187 already catches `SpawnPolicyViolation` — add `recordSpawnViolation(proposal.id)` there.

3. **Transition queue dispatch (`_dispatchTransitionQueue`, line 1370)** — Add `isSpawnBlocked(transition.proposal_id)` check before `selectExecutorWorktree(requestedWorktree)`. If blocked, update transition_queue status and return. **Critical**: wrap `spawnAgent()` call (line 1414) in try/catch — currently uncaught `SpawnPolicyViolation` would crash the dispatch.

### Fix 3: Escalation dedup in `assertSpawnAllowed`

**File:** `src/core/orchestration/agent-spawner.ts`
**Location:** `assertSpawnAllowed()` at line 373

**Design:**
```typescript
// In-memory dedup: prevent identical escalation inserts within 5-minute window.
const escalationDedup = new Map<string, number>(); // key -> timestamp
const ESCALATION_DEDUP_WINDOW_MS = 5 * 60 * 1000;

async function assertSpawnAllowed(
    host: string,
    route: ModelRoute,
    proposalId?: number,
    worktree?: string,
): Promise<void> {
    const { rows } = await query<{ allowed: boolean }>(
        `SELECT roadmap.fn_check_spawn_policy($1, $2) AS allowed`,
        [host, route.routeProvider],
    );
    const allowed = rows[0]?.allowed ?? true;
    if (allowed) return;

    // Dedup: skip INSERT if identical violation logged within window
    const dedupKey = `SPAWN_POLICY_VIOLATION:${proposalId ?? 'null'}:${worktree ?? 'null'}`;
    const now = Date.now();
    const lastLogged = escalationDedup.get(dedupKey);
    if (!lastLogged || now - lastLogged > ESCALATION_DEDUP_WINDOW_MS) {
        try {
            await query(
                `INSERT INTO roadmap.escalation_log
                    (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
                 VALUES ('SPAWN_POLICY_VIOLATION', $1, $2, 'orchestrator', 'high', $3)`,
                [
                    proposalId !== undefined ? String(proposalId) : null,
                    worktree ?? null,
                    `host=${host} route_provider=${route.routeProvider} model=${route.modelName}`,
                ],
            );
            escalationDedup.set(dedupKey, now);
        } catch (err) {
            console.error(`[P407] Failed to write escalation_log for spawn violation:`, err);
        }
    }

    throw new SpawnPolicyViolation(host, route.routeProvider, route.modelName);
}
```

### Fix 4: Clean up `hermes/agency-xiaomi` from agent_registry

**Action:** Verify on disk. If worktree directory exists at `/data/code/worktree/hermes/agency-xiaomi/`, leave it. If not, either:
- **Option A (preferred):** Remove from `agent_registry`:
  ```sql
  DELETE FROM roadmap_workforce.agent_registry
  WHERE agent_identity = 'hermes/agency-xiaomi'
    AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables -- verify no FK references
    );
  ```
- **Option B:** Create the worktree directory with a minimal `.env.agent` if the agent is actively used.

### Fix 5: Batch-resolve stale escalations

**Action:** One-time SQL migration:
```sql
-- Resolve all unresolved SPAWN_POLICY_VIOLATION escalations
UPDATE roadmap.escalation_log
SET resolved_at = now(),
    resolution_note = 'P407 cascade cleanup — backoff/dedup fix'
WHERE obstacle_type = 'SPAWN_POLICY_VIOLATION'
  AND resolved_at IS NULL;

-- Resolve AGENT_DEAD escalations for hermes/agency-xiaomi
UPDATE roadmap.escalation_log
SET resolved_at = now(),
    resolution_note = 'P407 cascade cleanup — agency-xiaomi registry fix'
WHERE obstacle_type = 'AGENT_DEAD'
  AND agent_identity LIKE '%agency-xiaomi%'
  AND resolved_at IS NULL;
```

## Design Rationale

### 1. In-Memory Map vs Database for Circuit Breaker

**Decision:** Use `Map<string, {count, firstAt}>` in orchestrator.ts, not a DB table.

**Why:** The circuit breaker is ephemeral — it only matters while the orchestrator process is running. A process restart naturally resets the cooldown, which is correct behavior (the underlying cause may have been fixed between restarts). DB-backed circuit breakers add write latency to every violation and require a cleanup job for expired entries. The orchestrator is a single-instance process, so in-memory state is sufficient. TTL is handled by checking `Date.now() - firstAt > WINDOW_MS` on each lookup — no background reaper needed.

**Trade-off:** If the orchestrator restarts, cooldown is lost. This is acceptable because: (a) the root cause would need to be re-triggered to restart the cascade, (b) a restart likely means someone fixed something, (c) the 10-minute window is short enough that even a missed cooldown only costs ~20 extra escalations.

### 2. Threshold and Window Tuning

**Circuit breaker:** 3 violations in 10 minutes. **Escalation dedup:** 5-minute window.

**Why:** The orchestrator polls every ~30s. In 10 minutes, that is ~20 polls. A threshold of 3 allows some transient failures but cuts off persistent policy violations quickly. The dedup window (5 min) is shorter than the circuit breaker window (10 min) so the first violation always gets logged for audit, but rapid-fire duplicates within the same poll cycle are suppressed.

**Tuning path:** Both values should be configurable via environment variables (`AGENTHIVE_SPAWN_CB_THRESHOLD`, `AGENTHIVE_SPAWN_CB_WINDOW_MS`, `AGENTHIVE_ESCALATION_DEDUP_MS`) for operational adjustment without code changes.

### 3. Why `selectExecutorWorktree` Returns Null Instead of Throwing

**Decision:** Return `null` when no worktree passes policy.

**Why:** The function is called from 4+ dispatch paths (lines 746, 1126, 1370, and within dispatchAgent). Each caller already has null-guard logic or uses `Promise.allSettled`. Throwing forces every caller to wrap in try/catch, and a throw in the middle of dispatch creates inconsistent state (cubic acquired but not released, dispatch row stuck in `assigned`). Returning null lets the caller decide: skip dispatch gracefully, release the cubic, and mark dispatch as blocked.

### 4. Transition Queue Dispatch Missing Error Handling

**Finding:** `_dispatchTransitionQueue` (line 1345) calls `spawnAgent()` at line 1414 without try/catch. If `assertSpawnAllowed` throws `SpawnPolicyViolation`, the error propagates uncaught up the call chain. In contrast, `dispatchImplicitGate` (line 1178-1201) wraps `spawnAgent` in try/catch and gracefully marks the dispatch as `blocked`.

**Fix:** Wrap the `spawnAgent` call in `_dispatchTransitionQueue` with the same try/catch pattern, marking the dispatch as `blocked` and updating the `transition_queue` status.

### 5. Escalation Dedup in `assertSpawnAllowed`, Not MCP Tool

**Decision:** Dedup lives in `assertSpawnAllowed()` (agent-spawner.ts), not in the escalation_add MCP tool.

**Why:** The MCP tool is a general-purpose interface. Other callers may legitimately want to log duplicate escalations. The orchestrator spawn path is the specific source of the cascade. Dedupping at the source prevents the storm without affecting other escalation producers.

### 6. `hermes/agency-xiaomi`: Registry vs Worktree

**Decision:** Verify first, then remove from `agent_registry` if no worktree exists.

**Why:** The agent_registry entry may be actively used by the gate-pipeline's OfferProvider (P297 self-registration). If the worktree exists, leave it. If it doesn't, the entry is a leftover that causes `scoreUsableWorktree` to return null for every dispatch attempt. Creating a dummy worktree wastes a slot and could cause confusing errors.

## Acceptance Criteria

### AC-1: selectExecutorWorktree returns null on no candidates
- **Given:** No worktree under `WORKTREE_ROOT` has a readable `.env.agent` and write access
- **When:** `selectExecutorWorktree()` is called
- **Then:** Returns `null` (does NOT throw)
- **Verification:** Unit test with mocked filesystem returning no usable worktrees
- **Code:** `scripts/orchestrator.ts` — change return type to `Promise<string | null>`, replace throw with `return null`

### AC-2: Circuit breaker blocks repeated spawn failures
- **Given:** A (proposal_id, agent) pair has 3+ SPAWN_POLICY_VIOLATIONs within 10 minutes
- **When:** The orchestrator attempts to dispatch that pair again
- **Then:** Dispatch is skipped with a warning log; no new escalation is created
- **Verification:** Unit test that calls `recordSpawnViolation` 3 times and asserts `isSpawnBlocked` returns true
- **Code:** `scripts/orchestrator.ts` — new `spawnViolationTracker` Map, `recordSpawnViolation()`, `isSpawnBlocked()`

### AC-3: Circuit breaker resets after window expiry
- **Given:** A (proposal_id, agent) pair was blocked by circuit breaker
- **When:** 10+ minutes pass since the first violation
- **Then:** `isSpawnBlocked` returns false; dispatch proceeds normally
- **Verification:** Unit test with fake timers advancing past window

### AC-4: Escalation dedup suppresses duplicate INSERT
- **Given:** `assertSpawnAllowed` was called with the same (proposal_id, worktree) within 5 minutes
- **When:** The second call occurs
- **Then:** No second INSERT into `escalation_log`; the SpawnPolicyViolation is still thrown
- **Verification:** Unit test with mocked DB that counts INSERT calls
- **Code:** `src/core/orchestration/agent-spawner.ts` — dedup Map in `assertSpawnAllowed`

### AC-5: First violation always logged
- **Given:** A spawn policy violation occurs for a (proposal_id, worktree) pair for the first time
- **When:** `assertSpawnAllowed` is called
- **Then:** One row is inserted into `escalation_log`
- **Verification:** Unit test asserting INSERT count = 1 on first call

### AC-6: Stale escalations batch-resolved
- **Given:** 10,632 unresolved SPAWN_POLICY_VIOLATION escalations exist
- **When:** The cleanup migration runs
- **Then:** `SELECT COUNT(*) FROM roadmap.escalation_log WHERE obstacle_type = 'SPAWN_POLICY_VIOLATION' AND resolved_at IS NULL` returns 0
- **Verification:** SQL query after migration
- **Code:** New SQL migration file

### AC-7: AGENT_DEAD escalations for agency-xiaomi resolved
- **Given:** 38 unresolved AGENT_DEAD escalations for hermes/agency-xiaomi
- **When:** The cleanup migration runs
- **Then:** All have `resolved_at` set and `resolution_note = 'P407 cascade cleanup'`
- **Verification:** SQL query after migration

### AC-8: Orchestrator logs no SPAWN_POLICY_VIOLATION storm after restart
- **Given:** The orchestrator is restarted with all fixes deployed
- **When:** A proposal with a policy-forbidden provider is in the dispatch queue
- **Then:** At most 3 escalations are created (circuit breaker threshold), then dispatch is silently skipped
- **Verification:** `journalctl -u agenthive-orchestrator --since "5 min ago" | grep SPAWN_POLICY_VIOLATION | wc -l` returns ≤ 3

### AC-9: Normal dispatch unaffected
- **Given:** A proposal with an allowed provider and usable worktree
- **When:** The orchestrator dispatches
- **Then:** Dispatch proceeds normally; circuit breaker does not interfere
- **Verification:** Integration test or manual dispatch of a valid proposal

### AC-10: Transition queue dispatch handles SpawnPolicyViolation gracefully
- **Given:** `_dispatchTransitionQueue` calls `spawnAgent()` which throws `SpawnPolicyViolation`
- **When:** The error propagates
- **Then:** The dispatch is marked as `blocked` in `squad_dispatch`, the `transition_queue` status is updated, and the error is logged — NOT an unhandled rejection
- **Verification:** Unit test or code review confirming try/catch wraps `spawnAgent()` in `_dispatchTransitionQueue`

## Implementation Plan

### Phase 1: Core Fixes (code changes)

**Step 1: selectExecutorWorktree null return**
- File: `scripts/orchestrator.ts`
- Change: Replace `throw` at line 667 with `return null`, update return type to `Promise<string | null>`
- Caller changes: Add null guards at lines 1126 and 1370 (see design section for code)
- Verify: TypeScript compiles, callers handle null

**Step 2: Circuit breaker implementation**
- File: `scripts/orchestrator.ts`
- Change: Add `spawnViolationTracker` Map, `recordSpawnViolation()`, `isSpawnBlocked()` near top of file
- Integration: Add `isSpawnBlocked` check before dispatch in `dispatchAgent()` and implicit gate path
- Integration: Call `recordSpawnViolation` on SpawnPolicyViolation catch

**Step 3: Escalation dedup**
- File: `src/core/orchestration/agent-spawner.ts`
- Change: Add `escalationDedup` Map and dedup check inside `assertSpawnAllowed()` before the INSERT
- Preserve: The `SpawnPolicyViolation` throw still happens (caller needs to know)

**Step 3b: Transition queue dispatch error handling**
- File: `scripts/orchestrator.ts`
- Change: Wrap `spawnAgent()` call at line 1414 in try/catch, matching the implicit gate pattern (line 1187-1201)
- On catch: mark dispatch as `blocked`, update `transition_queue` status, log warning

### Phase 2: Cleanup (data + registry)

**Step 4: Verify hermes/agency-xiaomi worktree on disk**
- Check: `ls -la /data/code/worktree/hermes/agency-xiaomi/.env.agent`
- If missing: Remove from `agent_registry` or create worktree

**Step 5: Batch-resolve stale escalations**
- Create SQL migration: `scripts/migrations/XXX-p407-cascade-cleanup.sql`
- Run migration against live DB
- Verify: counts go to 0

### Phase 3: Verification

**Step 6: Unit tests**
- File: `tests/unit/p407-circuit-breaker.test.ts` — threshold, window expiry, reset
- File: `tests/unit/p407-escalation-dedup.test.ts` — first insert, dedup, window expiry

**Step 7: Restart and monitor**
- `systemctl restart agenthive-orchestrator`
- Monitor: `journalctl -u agenthive-orchestrator -f`
- Verify: No SPAWN_POLICY_VIOLATION storm

## Dependencies

- **P245** (COMPLETE): Hermes host spawn policy — `fn_check_spawn_policy` must exist for `assertSpawnAllowed` to work
- **P269** (COMPLETE): Stale-row reaper — already handles stale dispatches/leases at startup
- **P376** (DRAFT): Automated stale dispatch reaper — may overlap with circuit breaker; coordinate to avoid conflicting cooldown mechanisms

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|:---|:---|:---|:---|
| Circuit breaker suppresses legitimate transient failures | Low | Medium | Threshold=3 allows 2 transient failures before blocking |
| In-memory state lost on restart | Medium | Low | Acceptable — restart likely means fix deployed |
| Batch UPDATE locks escalation_log | Low | Low | Use `WHERE resolved_at IS NULL` to limit scope; table is append-heavy |
| hermes/agency-xiaomi removal breaks gate-pipeline OfferProvider | Medium | High | Verify worktree exists before removing; check OfferProvider startup code |
| Transition queue dispatch crashes on unhandled SpawnPolicyViolation | High | High | Add try/catch matching implicit gate pattern (AC-10) |
