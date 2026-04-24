# P381 — Spin Detection: Auto-Hold Proposals with Repeated Failures

## Problem Statement

Proposals with broken agents or misconfigured dispatches loop indefinitely, burning credits on each failed spawn. Real data from 24h:

| Proposal | Failed Dispatches | Status |
|----------|-------------------|--------|
| gate-P047-D3 | 165 | All failed, all from hermes/agency-xiaomi |
| gate-P228-D3 | 165 | Same pattern |
| P307-build | 129 | Repeated spawn failures |
| P308-build | 122 | Same |

Root cause: `fn_claim_work_offer` lacks host_model_policy checks — agents with incompatible providers/machines claim offers that fail at spawn time. This RFC is a **safety net** to cap damage when root-cause failures slip through. The root-cause fix (P289 host_model_policy enforcement) should be prioritized separately.

## Design Decisions

### Decision 1: Separate spin_lock table (NOT new maturity)

Rejected: Adding `held` maturity — would require DDL migration, update to `proposal_maturity_check` constraint, `reference_terms`, and every maturity-check in the codebase. Blast radius too high.

Rejected: `is_held` boolean on proposal — mixes governance concern with proposal lifecycle, complicates queries.

**Chosen**: New table `roadmap_proposal.proposal_spin_lock` with a trigger that blocks dispatch creation when locked.

```sql
CREATE TABLE roadmap_proposal.proposal_spin_lock (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id     BIGINT NOT NULL REFERENCES roadmap_proposal.proposal(id),
  locked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by       TEXT NOT NULL DEFAULT 'spin-detector',
  failure_count   INTEGER NOT NULL,
  window_minutes  INTEGER NOT NULL,
  unlock_reason   TEXT,
  unlocked_at     TIMESTAMPTZ,
  created_by      TEXT NOT NULL DEFAULT 'spin-detector'
);

CREATE UNIQUE INDEX spin_lock_active_idx 
  ON roadmap_proposal.proposal_spin_lock(proposal_id) 
  WHERE unlocked_at IS NULL;
```

Advantage: Zero impact on existing maturity/status workflows. Can be added without touching any existing code paths initially.

### Decision 2: Time-bucketed per-proposal failure counting

Query for spin detection (runs periodically):

```sql
SELECT 
  proposal_id,
  COUNT(*) FILTER (WHERE dispatch_status = 'failed') as failures,
  MIN(assigned_at) as window_start
FROM roadmap_workforce.squad_dispatch
WHERE assigned_at > now() - interval '60 minutes'
GROUP BY proposal_id
HAVING COUNT(*) FILTER (WHERE dispatch_status = 'failed') > 10;
```

Uses existing `squad_dispatch.dispatch_status` column — no schema changes to dispatch table.

### Decision 3: Pipeline integration point

Two-part integration:

**Part A — Detection**: New function `checkSpinProposals()` in `health-monitor.ts`, extending `checkSpawnFailureRate()` which already queries `squad_dispatch`. The existing method detects GLOBAL failure rates; the new method detects PER-PROPOSAL failure spikes.

Location: `src/core/pipeline/health-monitor.ts`, new method after line 370.

**Part B — Guard**: Create a PostgreSQL function `fn_is_proposal_spinning(p_proposal_id BIGINT)` that returns TRUE if an active lock exists. Hook into `fn_claim_work_offer` (or a wrapper) to skip proposals with active locks.

```sql
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_is_proposal_spinning(p_proposal_id BIGINT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM roadmap_proposal.proposal_spin_lock
    WHERE proposal_id = p_proposal_id AND unlocked_at IS NULL
  );
$$ LANGUAGE sql STABLE;
```

### Decision 4: Recovery path

1. **Auto-recovery**: After 24h, auto-unlock if no new failures (configurable via `recovery_minutes`).
2. **Manual recovery**: `unlock_proposal(display_id, reason)` via MCP tool or SQL.
3. **Re-dispatch**: When unlocked, proposal is eligible for dispatch again. If maturity/status still warrants dispatch, orchestrator will pick it up on next cycle.
4. **Failure counter reset**: Unlock resets the spin detection counter for that proposal.

```sql
-- Manual unlock
UPDATE roadmap_proposal.proposal_spin_lock
SET unlocked_at = now(), unlock_reason = $reason
WHERE proposal_id = $id AND unlocked_at IS NULL;
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  PipelineCron (30s)                  │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Existing: detectMatureProposals()              │ │
│  │  Existing: checkSpawnFailureRate() [global]     │ │
│  │  NEW: checkSpinProposals() [per-proposal]       │ │
│  │         │                                       │ │
│  │         ├─→ INSERT proposal_spin_lock            │ │
│  │         │   (for proposals exceeding threshold)  │ │
│  │         │                                       │ │
│  │         └─→ UPDATE squad_dispatch SET            │ │
│  │             dispatch_status='cancelled'          │ │
│  │             WHERE proposal_id = X                │ │
│  │               AND dispatch_status IN             │ │
│  │                 ('assigned','active','open')     │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  fn_claim_work_offer()                          │ │
│  │    NEW: WHERE NOT fn_is_proposal_spinning(pid)  │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│               Recovery (daily cron)                  │
│  Auto-unlock locks older than 24h with no new        │
│  failures in the last 2h window                      │
└─────────────────────────────────────────────────────┘
```

## Proposed Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | A proposal with >10 `dispatch_status='failed'` entries in `roadmap_workforce.squad_dispatch` within 60 minutes gets a row in `proposal_spin_lock` with `unlocked_at IS NULL` | `psql` query after triggering failures |
| 2 | While `proposal_spin_lock` has active row, `fn_is_proposal_spinning()` returns TRUE and `fn_claim_work_offer` skips the proposal | Attempt claim on locked proposal; should get no offer |
| 3 | Spin detection alert sent via `pg_notify('spin_detection', ...)` with JSON payload `{proposal_id, display_id, failure_count, locked_at}` | Listen on channel, verify payload |
| 4 | Manual unlock: calling `unlock_proposal(display_id, reason)` sets `unlocked_at` and makes proposal eligible for dispatch again | Query lock table, then claim offer successfully |
| 5 | Auto-unlock: locks older than 24h with no failures in last 2h are automatically cleared | Wait for recovery cycle or invoke manually; verify `unlocked_at` set |

## Dependencies

- **P289** (host_model_policy enforcement): Root cause fix. This RFC is a safety net; P289 reduces the failure rate but doesn't eliminate all spin scenarios.
- **None blocking**: This feature can be built independently of P289.

## Implementation Plan

### Phase 1: Database (no code changes)
1. Create `proposal_spin_lock` table + index
2. Create `fn_is_proposal_spinning()` function
3. Create `unlock_proposal()` function
4. Add optional guard to `fn_claim_work_offer` (WHERE NOT fn_is_proposal_spinning)

### Phase 2: Detection
5. Add `checkSpinProposals()` to `health-monitor.ts`
6. Wire into `PipelineCron` polling loop
7. Emit `pg_notify('spin_detection', ...)` on lock

### Phase 3: Recovery
8. Add auto-unlock cron (daily, unlocks stale locks)
9. Add MCP tool `proposal_spin_unlock` for manual recovery
10. Add dashboard widget showing locked proposals

## Open Questions

1. Should gate dispatches (gate-PXXX-DN) and feature dispatches (PXXX-build, PXXX-ship) have different thresholds? Gate dispatches naturally fail more (3 gates per proposal).
2. Should we notify the agent that claimed the failing dispatches, or only operators?
3. Integration with P375 Discord bridge — send alerts to which channel?
