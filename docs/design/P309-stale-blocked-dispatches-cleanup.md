# P309: Stale Blocked Dispatches Cleanup

## Problem

`roadmap_workforce.squad_dispatch` has 2961 dispatches with `dispatch_status='blocked'` from the pre-P281 era. All 2961 share the same error:
```
[P245] Spawn policy violation: host "bot" is not permitted to run route_provider "github" (model "claude-opus-4-6").
```

These are dead rows from a misconfigured route where the "bot" host tried to use github provider for claude-opus-4-6, which was forbidden by host_model_policy.

### Data snapshot (2026-04-20)

| dispatch_status | count | completed_at set |
|-----------------|-------|-----------------|
| active          | 5     | 0               |
| blocked         | 2961  | 2961 (100%)     |
| cancelled       | 216   | 216             |
| completed       | 576   | 576             |
| failed          | 290   | 282             |

Key facts:
- 85% of all dispatch history is blocked dead data
- No active leases reference these dispatches
- None are recent (all older than 1 hour)
- The stale reaper (P269) only cleans WHERE completed_at IS NULL — blocked rows escape

## Design

### Two changes, no new tables or functions

**1. One-time data cleanup (SQL migration)**

```sql
-- Cancel all blocked dispatches — they are dead pre-P281 data
UPDATE roadmap_workforce.squad_dispatch
SET dispatch_status = 'cancelled',
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'cleaned_at', to_jsonb(now()),
        'cleaned_reason', 'P309: pre-P281 blocked dispatch cleanup'
    )
WHERE dispatch_status = 'blocked';
```

Expected: 2961 rows affected. Safe because:
- All have completed_at set (already terminal)
- No active leases reference them
- No recent dispatches match (all > 1 hour old)

**2. Update stale reaper to prevent recurrence (TypeScript)**

File: `src/core/pipeline/reap-stale-rows.ts`

Add a second UPDATE block that also cancels blocked dispatches where completed_at IS NOT NULL. This catches any future dispatches that land in 'blocked' state with completed_at set (e.g. from SpawnPolicyViolation or other pre-spawn failures).

```typescript
// P309: Cancel blocked dispatches with completed_at set (pre-spawn failures)
try {
    const r = await pool.query(
        `UPDATE roadmap_workforce.squad_dispatch
         SET dispatch_status = 'cancelled',
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'reaped_at', to_jsonb(now()),
                 'reaped_reason', 'P309: blocked dispatch with completed_at set'
             )
         WHERE dispatch_status = 'blocked'
           AND completed_at IS NOT NULL
         RETURNING id`,
    );
    // Add to result — reuse 'dispatches' counter or add a new one
    result.dispatches += r.rowCount ?? 0;
} catch (err) {
    logger.warn(
        `[${tag}] blocked dispatch reap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
}
```

Note: This is separate from the existing reap block (lines 84-102) which handles active/assigned dispatches with completed_at IS NULL. The two blocks cover different failure modes:
- Existing: agent spawned but crashed/was killed (completed_at NULL)
- New: dispatch failed before spawn (completed_at set, status blocked)

### ReapResult change (optional)

The current `ReapResult` interface has a single `dispatches` counter. We can either:
- (A) Accumulate into the existing `dispatches` field (simplest, slight loss of granularity)
- (B) Add a `blockedDispatches: number` field for separate tracking

Recommendation: Option A — the reaper log line already includes the total, and separate counting adds complexity for no operational benefit.

## Files to modify

| File | Change |
|------|--------|
| `database/ddl/` (new migration) | One-time UPDATE to cancel blocked dispatches |
| `src/core/pipeline/reap-stale-rows.ts` | Add blocked dispatch reap block after existing dispatch reap |

## Testing

1. Before migration: `SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch WHERE dispatch_status='blocked';` → expect 2961
2. After migration: same query → expect 0
3. After migration: `SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch WHERE dispatch_status='cancelled' AND metadata @> '{"cleaned_reason": "P309"}'::jsonb;` → expect 2961
4. Reaper test: verify the new reap block is covered by unit tests in `tests/unit/pipeline-cron.test.ts`
