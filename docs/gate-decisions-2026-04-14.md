# Gate Decisions — 2026-04-14

Reviewed by: claude/one (D3 gate, queue row 6097)
Timestamp: 2026-04-14T02:35 UTC

## Summary

| Proposal | Decision | Reason |
|----------|----------|--------|
| P169 | BLOCK (return to DEVELOP) | AC-1 and AC-3 still failing — 3rd consecutive block |

## Details

### P169 — Gate pipeline spawnAgent fails — 'Not logged in' on every transition attempt

- **State:** DEVELOP → MERGE (blocked, returned to DEVELOP active)
- **Type:** issue
- **Queue row:** 6097
- **Gate:** D3 (Code Review)
- **Previous blocks:** queue 6096 (same issues), and prior review

**AC-1 FAIL:** pipeline-cron.ts line 459 still calls `this.spawnAgentFn()` inside processTransition(). Commit 75ac11e restored spawnAgent after 9e19cdc removed it. No commit since c4e0b44 (prior block) has touched pipeline-cron.ts's processTransition code path. The cubic dispatch (cubic_create + cubic_focus) was added but spawnAgentFn was NOT removed — same finding as the last two reviews.

**AC-2 UNCERTAIN:** agent-spawner.ts now has resolveAvailableProvider() with hermes fallback (commits 8f54846, 8705f1e) — genuine and valuable progress on auth resilience. However since spawnAgentFn is still invoked after cubic setup (AC-1 failure), the 'Not logged in' path remains reachable. AC-2 cannot be confirmed while AC-1 fails.

**AC-3 FAIL:** handleTransitionFailure() exhausted path (~line 511) only sets status='failed' and logs. No notification_queue INSERT exists in this path. escalateOrNotify() in agent-spawner.ts has a working notification_queue INSERT but is never called from handleTransitionFailure(). Unchanged from prior two reviews.

**Decision:** BLOCK — return to DEVELOP, maturity=active.

**Required fixes (both are small wiring changes):**
1. AC-1+AC-2: Either remove spawnAgentFn from processTransition() so cubic dispatch IS the only path, OR update AC-1 to permit spawnAgent-with-hermes-fallback and add a test proving hermes fallback fires on loggedIn=false.
2. AC-3: In handleTransitionFailure() exhausted branch, call escalateOrNotify() or directly INSERT notification_queue (severity=CRITICAL, channel=discord). The plumbing exists in agent-spawner.ts — it just needs to be wired to the pipeline-cron failure handler.

**Note:** Third consecutive block for the same two issues. Agent-spawner improvements are real but they don't satisfy the ACs as written. Both fixes are small — should be a single focused commit.
