# P190: Pipeline Health Monitor -- Anomaly Detection & Alerting

**Proposal:** P190
**Title:** Orchestrator lacks anomaly detection -- gate pipeline stuck in retry loop for hours undetected
**Type:** issue
**Status:** COMPLETE
**Verified by:** worker-8859 (documenter)
**Date:** 2026-04-21

## Problem (Root Cause)

The gate pipeline (PipelineCron) was stuck in a retry loop for 2+ hours, requeueing the same 4 transitions (1013-1016) every 3 minutes with "Not logged in" errors. The orchestrator did not detect or alert on this anomaly. The Discord bridge showed no warnings. The state machine appeared to be running but was actually dead -- spinning, not progressing.

This exposed a critical observability gap: no automated anomaly detection existed for the gate pipeline or agent dispatch systems.

## Implementation

### Code Artifacts

| File | Purpose |
|:-----|:--------|
| `src/core/pipeline/health-monitor.ts` | HealthMonitor class -- periodic anomaly detection (430 lines) |

### Architecture

The `HealthMonitor` class runs as a periodic timer (default: 60-second intervals) and performs 4 independent health checks in parallel. All checks are pure SQL queries against existing tables -- zero LLM cost.

Alerts flow through two channels:
1. Discord bridge -- via `discordSend()` which publishes to `pg_notify('discord_send')`, picked up by the discord-bridge process
2. notification_queue -- persistent DB record for audit trail

10-minute cooldown per alert type prevents alert storms.

### The Four Checks

#### 1. Repeated Failure Detection
- Query: `transition_queue` where `attempt_count >= threshold` AND status = pending AND `last_error` is not null
- Threshold: 3 failures (configurable)
- Alert level: warning
- Purpose: Detects the exact problem from the original incident -- same transition failing repeatedly but not yet exhausted

#### 2. System-Wide Stall Detection
- Query: Counts recent completions vs failures in the last N minutes
- Threshold: All recent completions are failures AND there are pending transitions stuck
- Window: 10 minutes (configurable)
- Alert level: error (CRITICAL)
- Purpose: Detects when the entire gate pipeline is frozen

#### 3. Queue Depth Monitoring
- Query: Tracks pending/processing/failed/done counts over time
- Threshold: Pending grew by 5+ but completions increased by less than 2, over 5+ snapshots
- Alert level: warning
- Purpose: Early warning for pipeline falling behind -- detects backlog growth before it becomes a stall

#### 4. Agent Spawn Failure Rate
- Query: `squad_dispatch` where `dispatch_status = 'failed'` in the last 15 minutes
- Threshold: >50% failure rate with minimum 3 dispatches
- Window: 15 minutes (configurable)
- Alert level: error (CRITICAL)
- Purpose: Detects when agents can't be spawned -- model connectivity or availability issues

### Configuration (via HealthMonitorDeps)

| Parameter | Default | Purpose |
|:----------|:--------|:--------|
| `checkIntervalMs` | 60,000 (1 min) | How often checks run |
| `repeatedFailureThreshold` | 3 | Same transition fails N times before alerting |
| `stallWindowMinutes` | 10 | Window for stall detection |
| `spawnFailureWindowMinutes` | 15 | Window for spawn failure rate |
| `spawnFailureRateThreshold` | 0.5 (50%) | Failure rate threshold |
| `senderIdentity` | "health-monitor" | Sender label in Discord alerts |

### Dependencies

| Dependency | Status |
|:-----------|:-------|
| `roadmap.transition_queue` table | Exists |
| `roadmap.notification_queue` table | Exists |
| `roadmap_workforce.squad_dispatch` table | Exists |
| `discordSend()` (`src/infra/discord/notify.ts`) | Exists |
| `pg_notify('discord_send')` channel | Active (discord-bridge) |

## Integration Status

**NOT WIRED INTO ORCHESTRATOR** -- the HealthMonitor class is defined but never instantiated or started.

No import of `health-monitor.ts` was found in `src/core/orchestration/orchestrator.ts` or `scripts/orchestrator.ts`. The class needs to be:

1. Imported in the orchestrator entry point
2. Instantiated: `const monitor = new HealthMonitor()`
3. Started: `monitor.start()`
4. Graceful shutdown: `monitor.stop()` on process exit

## Known Issues

1. **Not integrated** -- HealthMonitor exists but is never started. The anomaly detection is dormant.
2. **No dedicated tests** -- No test file for HealthMonitor. Existing health tests (`tests/integration/s147.3-agent-health.test.ts`, `tests/integration/proposal-43-dag-health.test.ts`) cover different health concerns.
3. **SQL column assumptions** -- Queries assume `transition_queue` has columns `attempt_count`, `max_attempts`, `last_error`, `processing_at`, `completed_at`, `status`. These should be verified against the actual DDL.

## AC Assessment

| Criterion | Status | Notes |
|:----------|:-------|:------|
| Repeated failure detection | IMPLEMENTED | Queries transition_queue, alerts after N failures |
| System-wide stall detection | IMPLEMENTED | Detects all-failures window with pending stuck |
| Queue depth monitoring | IMPLEMENTED | Trend detection over 5+ snapshots |
| Agent spawn failure tracking | IMPLEMENTED | Queries squad_dispatch failure rate |
| Discord notification | IMPLEMENTED | Via discordSend + notification_queue |
| Integrated into orchestrator | **NOT DONE** | Class exists but not started |
| Tests | **NOT DONE** | No test file for HealthMonitor |

## Verdict

**PARTIALLY SHIPPED** -- The HealthMonitor implementation is complete and well-structured, but it is not integrated into the orchestrator. The anomaly detection code will not run until it is wired into the main orchestrator loop.

### Recommended Next Steps
1. Wire HealthMonitor into `src/core/orchestration/orchestrator.ts` or `scripts/orchestrator.ts`
2. Verify SQL column assumptions against actual `transition_queue` DDL
3. Add integration test for HealthMonitor
4. Verify Discord alert delivery end-to-end

## Related Files

- `src/core/pipeline/health-monitor.ts` -- Implementation (430 lines)
- `src/infra/discord/notify.ts` -- discordSend() used for alerts
- `src/infra/discord/bridge.ts` -- Listens on pg_notify('discord_send')
- `scripts/migrations/020-fix-gate-pipeline.sql` -- Related gate pipeline fix (P309)
- `src/core/orchestration/orchestrator.ts` -- Needs HealthMonitor integration
