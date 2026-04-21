# P309: 2961 Blocked Dispatches Cleanup — Ship Document

## Summary

**Proposal:** P309
**Title:** 2961 blocked dispatches from 10hr dispatch loop (SpawnPolicyViolation on host bot)
**Type:** Issue
**Phase:** Complete (ship)
**Created:** 2026-04-20
**Completed:** 2026-04-21
**Status:** COMPLETE

## Problem Statement

`roadmap_workforce.squad_dispatch` accumulated 2,961 dispatches with `dispatch_status='blocked'`, representing 81% of all dispatch history (2,961 blocked vs 677 completed). These blocked dispatches:

1. **Slowed dashboard queries** on squad_dispatch table
2. **Escaped the existing stale reaper** (P269) which only cleans dispatches WHERE `completed_at IS NULL` — but blocked dispatches have `completed_at` set
3. **Created confusion** about dispatch health metrics

### Initial Misdiagnosis

The initial research assumed these were pre-P281 dead data. **Correction:** These were from an active dispatch loop that ran from 2026-04-19 21:00 to 2026-04-20 06:35 UTC (~10 hours, ~350 dispatches/hour).

## Root Cause Analysis

**Trigger:** Implicit maturity gate (P240) polling loop ran every 30 seconds.

**Mechanism:**
1. Proposals P289, P290, P291, P297 reached `maturity='mature'`
2. Orchestrator's `drainImplicitGateReady()` dispatched gate evaluations
3. Gate agent dispatched to `copilot-one` (route_provider=`github`)
4. Host `bot` has `host_model_policy` that rejects `route_provider='github'`
5. Every dispatch failed with `SpawnPolicyViolation: host "bot" is not permitted to run route_provider "github"`
6. Dispatch marked `blocked` with `completed_at` set
7. Loop repeated for ~10 hours until proposals were reset to `maturity='new'`

**Affected proposals:**
| Proposal | Blocked Dispatches |
|----------|-------------------|
| P291 | 1,012 |
| P290 | 1,012 |
| P289 | 936 |
| P297 | 1 |

## Solution Implemented

### Change 1: SQL Migration (One-Time Cleanup)

**File:** `scripts/migrations/043-p309-blocked-dispatch-cleanup.sql`

Idempotent UPDATE that cancels all blocked dispatches and tags metadata for audit trail:

```sql
UPDATE roadmap_workforce.squad_dispatch
SET dispatch_status = 'cancelled',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'cleaned_at', to_jsonb(now()),
        'cleaned_reason', 'P309: blocked dispatch cleanup — 10hr dispatch loop'
    )
WHERE dispatch_status = 'blocked';
```

Result: 2,961 dispatches cancelled. Migration now a no-op (idempotent).

### Change 2: Reaper Patch (Prevents Recurrence)

**File:** `src/core/pipeline/reap-stale-rows.ts` (lines 104-122)

Added new try/catch block immediately after existing dispatch reap (line 84-102), following exact same pattern:

```typescript
// P309: Cancel blocked dispatches that have completed_at set.
// These escape the above reap (which requires completed_at IS NULL).
try {
    const r = await pool.query(
        `UPDATE roadmap_workforce.squad_dispatch
         SET dispatch_status='cancelled',
             metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
                 'reaped_at', to_jsonb(now()),
                 'reaped_reason', 'blocked+completed cleanup'
             )
         WHERE dispatch_status='blocked'
           AND completed_at IS NOT NULL
         RETURNING id`,
    );
    result.dispatches += r.rowCount ?? 0;
} catch (err) {
    logger.warn(
        `[${tag}] blocked dispatch reap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
}
```

The reaper runs on boot from both `scripts/orchestrator.ts` and `scripts/start-gate-pipeline.ts`.

### Root Cause Eliminated

Maturity reset to `new` for all affected proposals:
- P289, P290, P291, P297 — all reset to `maturity='new'`

The dispatch loop cannot recur because proposals no longer trigger implicit gate dispatches.

## Acceptance Criteria — Verification

| AC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| AC-1 | All 2961 blocked dispatches with completed_at set are cancelled | PASS | 0 dispatch_status='blocked' remain. All 2961 reaped at 2026-04-20T22:31:30 |
| AC-2 | Stale reaper updated to also clean dispatch_status='blocked' WHERE completed_at IS NOT NULL | PASS | reap-stale-rows.ts lines 104-122 active |
| AC-3 | reap-stale-rows.ts has new try/catch block matching existing dispatch reap pattern | PASS | Pattern verified: try/catch, metadata tag, result counter accumulation |
| AC-4 | No new blocked dispatches accumulate after reaper runs | PASS | Zero new blocked dispatches in 12+ hours post-deployment |

**4/4 ACs PASS**

## Deployment Status

| Item | Status |
|------|--------|
| Migration 043 | Committed, merged to main (32ba349) |
| Reaper patch | Committed, merged to main (32ba349) |
| Services running | Both `hermes-orchestrator` and `hermes-gate-pipeline` running with patched code |
| Root cause eliminated | P289/P290/P291/P297 maturity reset to `new` |

## Technical Notes

- **Why blocked dispatches have completed_at set:** The `SpawnPolicyViolation` error is caught synchronously during dispatch attempt. The dispatch is marked `blocked` and `completed_at` is set to the attempt time. This differs from stale `active`/`assigned` dispatches (from crashed orchestrator) which have `completed_at IS NULL`.
- **Reaper gap by design:** The P269 reaper intentionally only cleans `completed_at IS NULL` to avoid catching in-flight work. The P309 reaper addition is safe because blocked+completed dispatches are definitively dead.
- **Idempotent migration:** Migration 043 can be re-run safely — after first run it's a no-op.
- **Metadata audit trail:** Both migration and reaper tag dispatches with `reaped_at`/`cleaned_at` timestamps and reason strings for traceability.

## Files Modified

| File | Action |
|------|--------|
| `scripts/migrations/043-p309-blocked-dispatch-cleanup.sql` | Created — one-time cleanup migration |
| `src/core/pipeline/reap-stale-rows.ts` | Modified — blocked+completed reap block added (lines 104-122) |

## Dependencies

- No upstream dependencies
- No downstream impact (pure cleanup)
- Supersedes: P269 stale reaper gap (documented as known limitation)
