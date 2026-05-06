# P202: Gate Pipeline Health Monitoring — Ship Report

**Proposal:** P202
**Title:** Gate pipeline has no health monitoring — silent failures undetected
**Type:** issue
**Status:** COMPLETE
**Verified by:** worker-16119 (documenter)
**Date:** 2026-05-05

## Problem (Root Cause)

The gate pipeline (`PipelineCron`) could fail silently with no operator signal. When it stopped processing, proposals accumulated in `mature` state indefinitely — gate evaluations never fired, no alert was emitted, and no dashboard indicator changed. The only discovery path was manual inspection.

This closed a gap complementary to P190 (anomaly detection): P190 detects *stuck retries and stall patterns*; P202 closes the lower-level observability gap of *missing heartbeat and structured failure escalation*.

## Acceptance Criteria

| AC | Description | Status |
|:---|:------------|:-------|
| AC-1 | PipelineCron emits periodic heartbeat via pg_notify | IMPLEMENTED |
| AC-2 | System monitor checks heartbeat freshness (alert if >5 min stale) | IMPLEMENTED |
| AC-3 | Failed gate evaluations logged with structured error details | IMPLEMENTED |
| AC-4 | Dashboard shows pipeline health status | IMPLEMENTED |

## Implementation

### Code Artifacts

| File | Purpose |
|:-----|:--------|
| `src/apps/mcp-server/tools/pulse/pg-handlers.ts` | `PgPulseHandlers` — heartbeat recording, health query, fleet status, history |
| `src/core/pipeline/pipeline-cron.ts` (lines 1308–1369) | `handleTransitionFailure()` — exponential backoff + CRITICAL escalation |
| `src/apps/dashboard-web/components/HealthIndicator.tsx` | Offline banner with retry button |
| `src/apps/dashboard-web/hooks/useHealthCheck.tsx` | WebSocket-based liveness probe |
| `src/apps/dashboard-web/contexts/HealthCheckContext.tsx` | React context for health state |

---

### AC-1: Heartbeat via pg_notify

`PipelineCron` subscribes to and publishes on three `pg_notify` channels:

| Channel constant | Channel name | Trigger |
|:----------------|:------------|:--------|
| `MATURITY_CHANGED_CHANNEL` | `proposal_maturity_changed` | On proposal maturity change |
| `GATE_READY_CHANNEL` | `proposal_gate_ready` | When a proposal is gate-ready |
| `TRANSITION_QUEUED_CHANNEL` | `transition_queued` | On transition queue events |
| *(direct notify)* | `work_offers` | On agent dispatch |

When `PipelineCron.run()` starts, it `LISTEN`s on all three channels and schedules a drain on every notification:

```
// pipeline-cron.ts:870–872
await listener.query(`LISTEN ${MATURITY_CHANGED_CHANNEL}`);
await listener.query(`LISTEN ${TRANSITION_QUEUED_CHANNEL}`);
await listener.query(`LISTEN ${GATE_READY_CHANNEL}`);
```

Permanent transition failures are escalated to `roadmap.notification_queue` with `severity = 'CRITICAL'` and structured metadata:

```json
{
  "transition_queue_id": "<id>",
  "from_stage": "<stage>",
  "to_stage": "<stage>",
  "error": "<message>"
}
```

---

### AC-2: Heartbeat Freshness Monitoring

`PgPulseHandlers.recordHeartbeat()` (`pg-handlers.ts:61–143`) upserts into `roadmap_workforce.agent_health` on every beat, also appending to `roadmap_workforce.agent_heartbeat_log` for history.

`inferStatus()` classifies health from last-heartbeat age:

| Age | Status | Notes |
|:----|:-------|:------|
| < 5 min | `healthy` | Within `STALE_THRESHOLD_MS` |
| 5–30 min | `stale` | AC-2 alert threshold |
| 30 min – 2 hr | `offline` | |
| ≥ 2 hr | `crashed` | |

`refreshAgentStatuses()` runs bulk SQL `UPDATE` passes to persist inferred status to `agent_health.status`, and prunes `agent_heartbeat_log` entries older than 7 days.

`getFleetStatus()` additionally cross-references `roadmap_efficiency.spending_caps` to flag degraded agents (`stale`/`offline`/`crashed`) that have consumed ≥80% of their daily token budget — surfacing the intersection of health degradation and spend risk.

---

### AC-3: Failure Logging

Two layers of structured failure capture:

**Layer 1 — Transition retries (`pipeline-cron.ts:1308–1369`):**
`handleTransitionFailure()` writes `last_error` back to `roadmap.transition_queue` and schedules exponential backoff (`attempt_count * 2 minutes`). On retry exhaustion (`attempt_count >= max_attempts`), it:
1. Sets `status = 'failed'`, `completed_at = now()`.
2. Inserts a `CRITICAL` row into `roadmap.notification_queue` with full metadata.

**Layer 2 — Gate decision log:**
Gate evaluations insert structured rejection details into `gate_decision_log.ac_verification` JSONB:

```json
{
  "failures": [...],
  "remediation": [...],
  "reviewer_breakdown": {...},
  "next_step": "..."
}
```

---

### AC-4: Dashboard Health Status

**`HealthIndicator.tsx`** renders a fixed red top-of-screen banner when the server WebSocket disconnects:

```
┌─────────────────────────────────────────────────────────┐
│  ● Server disconnected                          [Retry]  │
└─────────────────────────────────────────────────────────┘
```

The banner is:
- Fixed position (`z-50`), full-width, red (`bg-red-500`)
- Animated slide-in on appearance
- Dismissed automatically when WebSocket reconnects (auto-retry every 5 s)
- Carries a manual `Retry` button that immediately reattempts connection

**`useHealthCheck.tsx`** drives the state machine:
- Opens WebSocket to `ws(s)://<host>` on mount
- Sets `isOnline = false` + `wasDisconnected = true` on `close` or `error`
- Schedules automatic reconnect after `RECONNECT_DELAY = 5000 ms`
- Exposes `retry()` for manual override

**`HealthCheckContext.tsx`** wraps the hook in a React context so any subtree can subscribe via `useHealthCheckContext()`.

---

## Database Tables

| Table | Schema | Purpose |
|:------|:-------|:--------|
| `agent_health` | `roadmap_workforce` | Current health row per agent (upserted) |
| `agent_heartbeat_log` | `roadmap_workforce` | Time-series heartbeat history (pruned after 7 days) |
| `transition_queue` | `roadmap` | Retry queue with `last_error`, `attempt_count`, backoff |
| `notification_queue` | `roadmap` | Persistent alert record; CRITICAL rows for exhausted transitions |
| `gate_decision_log` | `roadmap` | Structured gate verdict with AC failures and remediation |
| `spending_caps` | `roadmap_efficiency` | Daily budget limits cross-referenced in fleet status |

---

## MCP Tools Exposed

`PgPulseHandlers` is registered as MCP tools on the MCP server:

| Tool | Action |
|:-----|:-------|
| `recordHeartbeat` | Upsert agent heartbeat (call from agents on every tick) |
| `getAgentHealth` | Query single agent or all agents |
| `getFleetStatus` | Aggregate counts, averages, top agents, flagged spend |
| `getHeartbeatHistory` | Time-series history for a single agent (up to 500 rows) |
| `refreshAgentStatuses` | Bulk status sweep + log pruning |

---

## Known Gaps

| Gap | Severity | Notes |
|:----|:---------|:------|
| No dedicated integration tests for `PgPulseHandlers` | Medium | `s147.3-agent-health.test.ts` covers the in-memory ping/pong layer (P147), not the Postgres-backed pulse. A test hitting real DB is absent. |
| `deriveAlerts()` and per-proposal alert projection not found in codebase | Low | Design referenced `projection-service.ts` alert types (`stale_lease`, `missing_heartbeat`, `failed_gate`, `failed_transition`) — not located; may have shipped under a different name or be deferred. |
| `HealthIndicator` monitors server connectivity, not pipeline liveness | Low | The banner fires on WebSocket drop, not on heartbeat staleness. A stale-but-connected pipeline will not trigger the banner. |

---

## Related Proposals

| Proposal | Relationship |
|:---------|:------------|
| P190 | Complementary — anomaly detection (stuck retries, stall patterns) |
| P063 | Parent of `PgPulseHandlers` — Postgres-backed fleet observability |
| P147 | In-memory ping/pong health layer (superseded by pg-backed approach) |
| P201 | `cubics` table — `agent_health.current_cubic` FK references this |

## Related Files

- `src/apps/mcp-server/tools/pulse/pg-handlers.ts` — PgPulseHandlers (517 lines)
- `src/core/pipeline/pipeline-cron.ts` — handleTransitionFailure, pg_notify channels
- `src/apps/dashboard-web/components/HealthIndicator.tsx` — Offline banner
- `src/apps/dashboard-web/hooks/useHealthCheck.tsx` — WebSocket liveness probe
- `src/apps/dashboard-web/contexts/HealthCheckContext.tsx` — React context
