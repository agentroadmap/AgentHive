# P309 Ship Verification
## 2961 blocked dispatches from 10hr dispatch loop (SpawnPolicyViolation on host bot)

**Proposal:** P309
**Type:** issue
**Status:** COMPLETE
**Ship Date:** 2026-04-21
**Verified By:** worker-6469 (documenter), worker-6062 (pillar-researcher), worker-6470 (pillar-researcher)
**Commits:** cf385cd (fix) + 32ba349 (comment correction) on main

---

## Root Cause

Implicit maturity gate (P240) dispatched copilot-one to host bot for gate evaluations.
Host bot's `host_model_policy` rejects `route_provider=github` — every dispatch failed with SpawnPolicyViolation.
Dispatch loop ran 2026-04-19 21:00 to 2026-04-20 06:35 UTC (~10 hours, ~350/hr).
Affected proposals: P290 (1012), P291 (1012), P289 (936), P297 (1).
Loop stopped via maturity reset to 'new' for all affected proposals.

## Changes

1. **SQL migration** (`scripts/migrations/043-p309-blocked-dispatch-cleanup.sql`):
   - Idempotent UPDATE cancels all 2961 blocked dispatches
   - Tags metadata with `cleaned_at` + `cleaned_reason` for audit trail
   - Now a no-op (all blocked dispatches already cancelled)

2. **Reaper patch** (`src/core/pipeline/reap-stale-rows.ts` lines 104-122):
   - New try/catch block after existing dispatch reap (line 84-102)
   - Cancels `dispatch_status='blocked'` WHERE `completed_at IS NOT NULL`
   - Matches existing dispatch reap pattern (try/catch + logger.warn + result counter)
   - Metadata stamped with `reaped_at` and `reaped_reason`
   - Runs on boot from both orchestrator and gate-pipeline

## Why blocked dispatches escaped the existing reaper

The P269 stale reaper cleans dispatches WHERE `completed_at IS NULL` (to avoid catching in-flight work).
Blocked dispatches have `completed_at` set because SpawnPolicyViolation is caught synchronously during dispatch.
The P309 reaper addition is safe because blocked+completed dispatches are definitively dead.

## Acceptance Criteria

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | All 2961 blocked dispatches with completed_at set are cancelled | **PASS** — 0 blocked dispatches remain |
| AC-2 | Stale reaper updated to also clean dispatch_status=blocked WHERE completed_at IS NOT NULL | **PASS** — code at lines 104-122 |
| AC-3 | reap-stale-rows.ts has new try/catch block matching existing dispatch reap pattern | **PASS** — consistent pattern |
| AC-4 | No new blocked dispatches accumulate after reaper runs | **PASS** — 0 blocked dispatches over 48h+ |

**4/4 ACs PASS**

## Verification

```sql
-- Result: 0 blocked dispatches
SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch WHERE dispatch_status='blocked';
```

## Dependencies

- No upstream dependencies
- No downstream impact (pure cleanup)
- Supersedes: P269 stale reaper gap (documented as known limitation)

**Status: SHIPPED. Proposal P309 is complete — no further work required.**
