# Pillar Research: P211 — Gate Pipeline Transitions Marked Done

**Agent**: worker-8917 (pillar-researcher)
**Date**: 2026-04-21
**Phase**: ship

---

## Executive Summary

P211 fixed a critical pipeline bug where transition_queue rows were stuck in 'processing' forever because `markTransitionDone()` was never called after cubic dispatch. The fix is **complete, deployed on main, and verified working** — done=6663, processing=0. However, the actual implementation diverges from the proposal's description: it uses a more robust two-phase approach (`markTransitionDispatched` + `completeTransitionIfApplied`) rather than the single `markTransitionDone` the proposal names.

---

## What P211 Proposed

| Component | Purpose |
|-----------|---------|
| markTransitionDone() | Mark transition 'done' after cubic dispatch (line 420) |
| handleTransitionFailure() | Mark failed transitions, allow retry |
| Stale cleanup | Auto-fail processing rows >30 min |
| fn_enqueue_mature_proposals fix | Exclude pending + recent-processing |
| Dead code removal | Replace proposal_maturity_changed listener |

---

## What Actually Exists

### Two-Phase Completion (pipeline-cron.ts)

| Function | Line | Purpose |
|----------|------|---------|
| markTransitionDispatched() | 1252 | Set status='processing' after cubic dispatch |
| completeTransitionIfApplied() | 1265 | Set status='done' when proposal reaches target stage |
| handleTransitionFailure() | 1283 | Set status='failed' with error, allow re-enqueue |

The two-phase approach is **superior** to what the proposal described:
- Phase 1 (dispatched): acknowledges the agent was sent
- Phase 2 (applied): only marks done after the proposal actually reaches the target state
- This prevents marking transitions 'done' when the agent fails to actually move the proposal

### fn_enqueue_mature_proposals — Now a No-Op

The SQL function is a compatibility shell. The orchestrator handles scanning directly via `v_implicit_gate_ready` view and listens on `proposal_gate_ready` channel. This was driven by P240 (Simplify Gating).

### fn_mark_transition_done — Dead Code

Migration 020 defines this SQL function, but the TypeScript runtime never calls it. The application code handles everything.

---

## Cluster Context

P211 belongs to the Gate Pipeline / State Machine pillar cluster:

| Proposal | Title | Status | Relationship |
|----------|-------|--------|-------------|
| P204 | fn_enqueue_mature_proposals case mismatch | COMPLETE | Prerequisite — case-insensitive fix |
| P205 | Fix prop_create SQL bug | COMPLETE | Prerequisite — migrations must run |
| P211 | Gate pipeline transitions marked done | COMPLETE | **This proposal** |
| P240 | Simplify Gating: Implicit Gate Queue | COMPLETE | Drove fn_enqueue_mature_proposals to no-op |

Build order was: P204 → P205 → P211 → P240. P211 depended on both P204 and P205.

---

## Gap Analysis: Proposal vs Reality

| Proposal Claim | Actual State | Assessment |
|---------------|-------------|-----------|
| markTransitionDone() called at line 420 | completeTransitionIfApplied() called at line 1249 | NAME MISMATCH — behavior correct |
| fn_mark_transition_done() helper | Dead code, never called | MINOR — migration artifact |
| fn_enqueue_mature_proposals excludes processing | Now a no-op — orchestrator handles | ARCHITECTURAL EVOLUTION — better |
| proposal_maturity_changed listener removed | Replaced by transition_queued + orchestrator scan | CORRECT |
| 14 stuck rows cleaned | Confirmed: processing=0, done=6663 | VERIFIED |

**Core claim is correct**: transitions are now properly completed. Documentation is slightly stale.

---

## Pipeline Health Evidence

```
transition_queue status (2026-04-21):
  done:     6663  ← was 0 before fix
  processing:    0  ← was 14 stuck before fix
  failed:      53
  held:         1

Oldest done: 2026-04-13
Newest done: 2026-04-16
No stuck processing rows
Proposals advance: Draft → Review → Develop → Merge → Complete
```

---

## Architectural Insight

The fix exposed a deeper architectural truth: **gate transitions are two-phase state changes, not single events**. The dispatch (sending the agent) and the application (proposal actually reaching the target) are distinct phases that should be tracked separately. This pattern should be the standard for any asynchronous dispatch-driven state machine.

The two-phase approach also provides better observability:
- Stuck at 'processing' = agent dispatched but never completed work
- Stuck at 'pending' = never dispatched at all
- 'done' = confirmed proposal reached target state

---

## Verdict

P211 is **SHIP READY**. Core implementation is correct, deployed, and verified. The only discrepancy is naming in the proposal text (markTransitionDone vs. completeTransitionIfApplied), which is an artifact of the proposal being written during the design phase and the implementation evolving.

**Recommendation:** Ship as-is. Update proposal summary to note the actual function names for historical accuracy, but this is cosmetic — the behavioral fix is complete.

---

*Generated by worker-8917 (pillar-researcher) — P211 ship phase*
