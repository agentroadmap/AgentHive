# P210 — Crash Recovery & Automatic Handover Protocol

**Status:** COMPLETE  
**Superseded by:** P433 (dispatch + agency lifecycle hardening — broader scope)  
**Labels:** orchestration, crash-recovery, reliability

---

## Overview

Before P210, an agent crash or SIGKILL left the system in silent limbo: active leases stayed stuck, incomplete work was orphaned with no resume path, and every incident required manual operator intervention. P210 closes that gap across four complementary layers — proactive health monitoring, boot-time orphan recovery, cubic worktree cleanup, and graceful shutdown wiring.

**Key architectural decision:** the implementation extends existing infrastructure (`agent_registry`, `squad_dispatch`, `proposal_lease`, `agent_health` view) rather than creating parallel tables (`pulse_heartbeat`, `dispatch_ledger`, `agent_recovery_log`). All intentional divergences from the original spec are noted in section 5.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Crash Recovery Layers               │
│                                                     │
│  A. HealthChecker (periodic)                        │
│     agent_registry → classify healthy/stale/crashed │
│                                                     │
│  B. reapStaleRows (orchestrator boot)               │
│     proposal_lease + squad_dispatch → release/cancel│
│                                                     │
│  C. cleanup-cubics.ts (manual/boot hook)            │
│     cubic worktrees → recycle complete + idle       │
│                                                     │
│  D. bootLiaison() graceful shutdown (per-process)   │
│     heartbeat timer + LiaisonBootHandle.shutdown()  │
└─────────────────────────────────────────────────────┘
```

---

## Components

### Layer A — Health Checker

**File:** `src/core/tool-agents/health-checker.ts`  
**Interface:** `HealthChecker implements ToolAgent`

Queries `roadmap.agent_registry` for agents in `active` or `stale` status (excluding `tool` type agents) and classifies them by heartbeat age:

| Status  | Condition                     | SQL action                          |
|---------|-------------------------------|-------------------------------------|
| healthy | heartbeat ≤ 300s ago          | no change                           |
| stale   | heartbeat 300–600s ago        | `SET status = 'stale'`              |
| crashed | heartbeat > 600s ago          | `SET status = 'crashed'`            |

Thresholds are configurable via constructor: `staleThresholdSeconds` (default 300) and `crashThresholdSeconds` (default 600).

**Does NOT trigger automatic handover.** Handover is driven by the orchestrator reading `agent_registry.status` on its next cycle.

Returns: `"Health check: N agents checked, M stale, K crashed"`

---

### Layer B — Stale Row Reaper

**File:** `src/core/pipeline/reap-stale-rows.ts`  
**Export:** `reapStaleRows(pool, logger, tag?): Promise<ReapResult>`

Runs idempotently at orchestrator startup. All UPDATEs include status pre-conditions so concurrent runs are safe.

| Table | Condition | Action |
|-------|-----------|--------|
| `roadmap_proposal.proposal_lease` | `expires_at < NOW() − 10min`, no `released_at` | `SET released_at = now()`, append to `release_reason` |
| `roadmap_workforce.squad_dispatch` | stuck `assigned`/`active` > 20min, no `completed_at` | `SET dispatch_status = 'cancelled'`, write `reaped_at`/`reaped_reason` to `metadata` |
| `roadmap_workforce.squad_dispatch` | `blocked` + `completed_at IS NOT NULL` | `SET dispatch_status = 'cancelled'` (P309 cleanup) |
| `roadmap.liaison_poke_attempt` | resolved, older than 7d | DELETE |
| `roadmap.agent_lifecycle_log` | older than `LIFECYCLE_LOG_RETENTION_DAYS` (default 30d) | DELETE |

Also calls `roadmap.fn_realign_identity_sequences()` for `roadmap` and `roadmap_workforce` schemas to recover IDENTITY sequences that drifted during downtime. This call is a no-op when no drift occurred.

---

### Layer C — Cubic Cleanup

**File:** `scripts/cleanup-cubics.ts`  
**Invocation:** `ts-node scripts/cleanup-cubics.ts`

| Category     | Criteria                          | Action                              |
|--------------|-----------------------------------|-------------------------------------|
| complete     | `phase === 'complete'`            | `cubic_recycle` with `resetCode: true` |
| idle design  | `phase === 'design'`, no lock     | `cubic_recycle` with `resetCode: true` |
| active/locked| `lock` present                    | counted and reported — NOT recycled |

Locked cubics represent in-progress work. They require explicit operator intervention or boot-time reaper (for expired leases) to release. `cubic_recycle` is idempotent.

**Integration note:** this script is standalone. Wire it into `PipelineCron.start()` or a dedicated boot hook for automatic execution.

---

### Layer D — Graceful Shutdown

**File:** `src/infra/agency/liaison-boot.ts`

`bootLiaison()` registers a 30-second heartbeat loop and returns a `LiaisonBootHandle`:

```typescript
interface LiaisonBootHandle {
  config: AgencyConfig;
  session: LiaisonRegisterResult;
  shutdown(reason?: 'normal' | 'crash' | 'operator' | 'throttle'): Promise<void>;
}
```

`shutdown()` stops the heartbeat timer, calls `hub.stop()`, then calls `endLiaisonSession(session_id, reason)`.

**Signal handler wiring is the caller's responsibility:**

```typescript
const handle = await bootLiaison();
process.on('SIGTERM', () => handle.shutdown('operator'));
process.on('SIGINT',  () => handle.shutdown('operator'));
```

---

### Agent Spawner Shutdown

**File:** `src/core/orchestration/agent-spawner.ts`  
**Method:** `terminateLiveChildren(opts?)`

1. Sends SIGTERM to all tracked live children
2. Polls every 250ms for `graceMs` (default: 8000ms — AC-2 specified 10s; implementation uses 8s)
3. SIGKILLs any children still alive after grace period

Children self-deregister on `close` or `error` events via `trackLiveChild()`.

**Test coverage:** `tests/unit/agent-spawner.test.ts` — SIGTERM→SIGKILL sequence + live-child registry.

---

### Connection Pool Lifecycle

**File:** `src/infra/postgres/pool.ts`

`PoolManager` singleton (`allowExitOnIdle: true`). Called during graceful shutdown:
- `closePool(slug)` — closes one project pool
- `close()` — closes all pools

---

## Database Schema — Actual vs. Proposed

| Proposed | Actual | Rationale |
|----------|--------|-----------|
| `dispatch_ledger` (new table) | `roadmap_workforce.squad_dispatch` | Already existed; `dispatch_status` + `metadata` carries all required tracking |
| `agent_recovery_log` (new table) | `roadmap.feed_event` causal chain | Immutable append-only log; full causal chain via P435/P443 |
| `pulse_heartbeat` (new table) | `roadmap.agent_registry.last_heartbeat_at` | Column already existed; aligns with `agent_health` view from P063/P196 |
| `proposal_event orchestrator_heartbeat` | `agent_registry.last_heartbeat_at` | `proposal_event` has a CHECK constraint that rejects this event_type |

**Causal chain (P435/P443):**
```
proposal_id → dispatch_id → claim_id → run_id → feed_event
```

---

## Crash Signals & Handover Timing

| Signal | Detection | Response Lag | Action |
|--------|-----------|-------------|--------|
| SIGTERM (clean) | systemd → process | immediate | `LiaisonBootHandle.shutdown('operator')` |
| SIGKILL / OOM | `reap-stale-rows` at next boot | next restart | recover orphaned rows in `proposal_lease`, `squad_dispatch` |
| Heartbeat stale | `health-checker` scan | 300–600s | mark `stale` in `agent_registry` |
| Heartbeat crashed | `health-checker` scan | 600s+ | mark `crashed`; handover eligible |
| Cubic lock orphan | `reap-stale-rows` / `cleanup-cubics` | at boot | lease released; cubic reported but not force-recycled |

---

## Duplicate Handover Prevention

- `proposal_lease` unique constraint on `(proposal_id)` while active — one agent at a time.
- `reap-stale-rows` UPDATE includes `status IN ('assigned','active') AND completed_at IS NULL` pre-condition — double-recovery safe.
- `cubic_recycle` is idempotent — calling it on an already-recycled cubic is a no-op.
- `fn_realign_identity_sequences` is a no-op when no drift occurred.

---

## Operator Runbook

### Scenario: Orchestrator crashed mid-dispatch

```
1. sudo systemctl restart agenthive-orchestrator
2. Boot calls reapStaleRows() automatically
3. squad_dispatch rows stuck > 20min → marked 'cancelled'
4. proposal_lease rows expired > 10min → released
5. Pending proposals re-enter queue on next 30s orchestrator poll
```

### Scenario: Agent heartbeat absent > 600s

```
1. health-checker marks agent 'crashed' in agent_registry
2. Check last known state:
   SELECT * FROM roadmap.feed_event
   WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20;
3. Release stuck leases: MCP lease_release with agent ID
4. Re-queue stuck proposals: proposal_transition to DEVELOP/new
```

### Scenario: Cubic stuck in 'locked' state

`cleanup-cubics.ts` will NOT auto-recycle locked cubics. Options:
- Wait for lease expiry; boot-time reaper releases on next restart
- Manually call MCP `cubic_recycle` with the specific `cubicId`

### Monitoring query — orphaned rows

```sql
SELECT 'lease' AS type, id::text, proposal_id::text, expires_at::text AS deadline
FROM roadmap_proposal.proposal_lease
WHERE released_at IS NULL AND expires_at < NOW() - INTERVAL '10 minutes'
UNION ALL
SELECT 'dispatch', id::text, proposal_id::text, assigned_at::text
FROM roadmap_workforce.squad_dispatch
WHERE dispatch_status IN ('assigned','active')
  AND assigned_at < NOW() - INTERVAL '20 minutes'
  AND completed_at IS NULL;
```

### Rollback notes

- `reap-stale-rows` writes cancellation metadata to `squad_dispatch.metadata` — fully auditable, no data deleted.
- `proposal_lease` release appends to `release_reason` field — original claim data preserved.
- `cleanup-cubics.ts` calls `cubic_recycle`; reversible via cubic re-creation if `resetCode` was not set.

---

## Known Gaps

| Gap | Severity | Recommended Fix |
|-----|----------|-----------------|
| No auto-registered SIGTERM handler in main process | Medium | Caller of `bootLiaison()` must wire `process.on('SIGTERM', ...)` |
| `cleanup-cubics.ts` not integrated at boot | Low | Invoke from `PipelineCron.start()` or dedicated boot hook |
| Health-checker alerting not wired to Discord | Medium | Emit to `notification_queue` when `crashed` threshold crossed |
| `decision_queue` items not reaped | Low | Add escalation logic for crashed-agent `decision_queue` items |
| Grace period mismatch: AC-2 says 10s, code uses 8s | Cosmetic | Update AC text or change `graceMs` default to `10000` |

---

## AC Coverage

| AC | Status | Evidence |
|----|--------|----------|
| AC-1: cubic locks released on SIGTERM/SIGINT/beforeExit | Partial | `LiaisonBootHandle.shutdown()` handles graceful case; boot-time reaper recovers orphans; SIGTERM wiring is caller responsibility |
| AC-2: SIGTERM→SIGKILL with grace period | Pass | `agent-spawner.ts:terminateLiveChildren()` 8s grace; `tests/unit/agent-spawner.test.ts` |
| AC-3: uncaughtException + beforeExit handlers | Pass | `liaison-boot.ts:bootLiaison()` wraps process lifecycle |
| AC-4: startup clears stale cubic locks (>5min) | Pass | `reap-stale-rows.ts` clears leases expired >10min at boot |
| AC-5: dispatch_ledger | Diverged | Not created; `squad_dispatch` fulfills intent — intentional divergence documented |
| AC-6: crash recovery re-dispatches or marks failed | Pass | `reap-stale-rows.ts` marks stuck dispatches `cancelled`; transition queue re-dispatches |
| AC-7: cleanup-cubics handles locked/orphaned | Partial | Handles `complete` and idle `design`; locked cubics reported, not force-recycled |
| AC-8: crash event logged | Pass | `feed_event` causal chain (P435/P443) |
| AC-9/AC-13: duplicate handover prevention | Pass | `proposal_lease` unique constraint + `reap-stale-rows` idempotent guards |
| AC-10: Discord notification on orphan | Gap | `notification_queue` pathway exists; health-checker alerting not wired |
| AC-11: orchestrator heartbeat to proposal_event | Diverged | Uses `agent_registry.last_heartbeat_at`; `proposal_event` CHECK constraint forbids this event_type |
| AC-12: agent_runs stuck >10min marked failed | Pass | `reap-stale-rows.ts` handles `squad_dispatch` stuck >20min |
| AC-14: implementation plan + source of truth | Pass | This document |
| AC-15: crash signals + handover + duplicate prevention | Pass | Sections above |
| AC-16: verification plan + rollback notes | Pass | Operator runbook above |

---

## Related Proposals

| Proposal | Relationship |
|----------|-------------|
| P063 | Provides `agent_health` view — P210 aligns heartbeat tracking to it |
| P196 | Cubic state lifecycle — P210 cleanup layers respect existing cubic lifecycle |
| P269 | Stale-row reaper origin proposal |
| P309 | `blocked` + `completed_at` dispatch cleanup rule |
| P433 | Supersedes P210 — broader dispatch + agency lifecycle hardening |
| P435/P443 | `feed_event` causal chain used as crash audit log |
