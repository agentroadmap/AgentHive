# Gate Decisions — 2026-04-13

**Reviewer**: architecture-reviewer
**Session**: Cron architecture review

| Proposal | Decision | Key Issues |
|----------|----------|------------|
| P178 | REQUEST CHANGES | Empty deps, duplicates P170, wrong type, weak ACs |
| P179 | REQUEST CHANGES | No dep on P178, duplicates P170, wrong type |
| P180 | REQUEST CHANGES | Prerequisites (P167/168/169) still in DEVELOP, zero deps registered |
| P183 | REQUEST CHANGES | No dep on P179, ACs test file existence not content |
| P184 | REQUEST CHANGES | Unverified tool references, no dep on P170/P055 |
| P185 | REQUEST CHANGES | No dep on P062, unverified schema references |
| P199 | REQUEST CHANGES | No architectural commitment, missing P149/P057 deps, 8KB limit |

## Summary

7 proposals reviewed. 7 REQUEST CHANGES. 0 APPROVE. 0 REJECT.

### Governance Cluster (P178–P185)
All six proposals form an implicit dependency chain (P178→P179→P183→P180→P184/P185) but have ZERO registered dependencies. They potentially duplicate the already-COMPLETE P170 governance framework. P180's prerequisites (P167, P168, P169) are still in DEVELOP status. All use `type: feature` but are actually research documents or specifications. ACs test document storage rather than behavioral outcomes.

**Required before re-review**: Register all cross-dependencies, clarify relationship to P170, defer P180 until P167/168/169 are COMPLETE, fix proposal types, strengthen ACs.

### P199 — Secure A2A Communication
Addresses real architectural problems (broadcast blast radius, no ACL, flat payloads) but presents three options without committing. Missing dependencies on P149 (channel subscriptions — COMPLETE) and P057 (zero-trust ACL — COMPLETE). Doesn't address pg_notify's 8KB payload limit which directly impacts Option A viability.

**Required before re-review**: Commit to Option C hybrid with rationale, link P149/P057, verify current channel_subscription state, propose phased implementation.

---

## D3 Gate — 2026-04-14T00:52 UTC (queue row 6096)

Reviewed by: gate-agent-d3

### Summary

| Proposal | Decision | Reason |
|----------|----------|--------|
| P169 | BLOCK — return to DEVELOP | AC-1: spawnAgent not removed; AC-3: notification_queue escalation missing |

### P169 — Gate pipeline spawnAgent fails — 'Not logged in'

- **State:** DEVELOP → MERGE (requested)
- **Type:** issue (Type B)
- **Queue row:** 6096

**AC-1 (cubic dispatch, no spawnAgent): FAIL**
pipeline-cron.ts line 12 still imports spawnAgent; line 459 still calls spawnAgentFn(). The cubic_create+cubic_focus block was added but spawnAgent was NOT removed. AC requires zero spawnAgent invocation in the transition handler path.

**AC-2 (no auth errors): UNCERTAIN/LIKELY FAIL**
Since spawnAgentFn is invoked after cubic setup, the subprocess path still executes and would still hit 'Not logged in' in production.

**AC-3 (notification_queue on 3+ failures): FAIL**
handleTransitionFailure() exhausted path only sets status=failed and logs. No notification_queue INSERT in pipeline-cron.ts at all. escalateOrNotify() in agent-spawner.ts is never called from the failure handler.

**Tests:** 5/5 PipelineCron unit tests pass but use mock spawnAgentFn — cubic-only dispatch and notification_queue escalation are not tested.

**Decision:** BLOCK. Returned to DEVELOP/active. Required fixes:
1. Remove spawnAgentFn import and call from processTransition().
2. Add notification_queue INSERT when transition exhausted (severity=CRITICAL, channel=discord).
3. Add tests for cubic-only dispatch path and exhausted-failure escalation.
