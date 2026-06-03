# AgentHive Platform SLA Contract

**Version:** 1.0.0  
**Effective:** 2026-06-02  
**Machine-readable schema:** `docs/sla-contract.json`  
**Runtime overrides:** `roadmap.sla_config` (DB table)  
**Source-of-truth hierarchy:** JSON > Markdown > DB overrides

> On divergence between this document and `docs/sla-contract.json`, the JSON is authoritative.

---

## 1. SLA Targets by Surface

| Surface | Metric | Target | Measurement Window |
|---|---|---|---|
| MCP API (all tool calls) | p99 call latency | < 500 ms at 100 concurrent agents | Rolling 5-min histogram (`roadmap.trace_span`) |
| MCP API (write calls) | Error rate | < 10% | Rolling 30-second window |
| Postgres | Restart RTO | < 5 min (single-node) | Systemd watchdog |
| Control-plane scheduler | Expiry gap | < TTL + 30 s | Heartbeat interval |
| Proposal workflow | State-transition latency | < 2 s per transition p99 | `roadmap.proposal_lifecycle_event` |
| Platform availability | Monthly uptime | ≥ 99.5% | Calendar month |

---

## 2. Availability Formula

```
Availability = (M - D_unplanned) / M × 100%

  M             = measurement window in minutes (calendar month = 43,200 min)
  D_unplanned   = minutes where MCP server is unreachable OR Postgres unavailable,
                  excluding planned maintenance windows

Planned maintenance
  - Announced ≥ 24 h in advance via MCP channel #ops
  - Maximum 4 hours/month excluded from D
  - Excess maintenance time counts as downtime

Partial outage
  - Degraded state sustained ≥ 30 s → counts as 0.5 × interval in D
  - Degraded state < 30 s → not counted

Error budget
  - (100% − 99.5%) × 43,200 = 216 minutes/month unplanned downtime allowed
  - When 50% consumed → freeze non-critical merges
  - When 100% consumed → formal incident declared, postmortem required
```

---

## 3. Platform State Machine

```
Normal  ──[any SLO breached > 30 s]──►  Degraded
Normal  ◄──[all SLOs within target 60 s]──  Degraded
Degraded  ──[MCP or Postgres unreachable > 30 s]──►  Down
Down  ──[MCP restored + Postgres connected + all SLOs OK]──►  Normal
```

| State | Observable Criteria | Notification | Automated Action |
|---|---|---|---|
| Normal | All SLOs within target | None | None |
| Degraded | Any SLO breached for > 30 s | `#alerts` via pg_notify `sla_state_change` | Log `roadmap.sla_events`; fire alert |
| Down | MCP or Postgres unreachable > 30 s | Best-effort | Auto-open incident; halt new lease grants |

State transitions are recorded in `roadmap.sla_events` and broadcast via `pg_notify('sla_state_change', ...)` to connected dashboard WebSocket clients.

---

## 4. Configuration Mechanism

Two-tier precedence (first match wins):

**Tier 1 — Environment variables** (set at deploy time):

| Variable | Default | Description |
|---|---|---|
| `SLA_P99_LATENCY_MS` | 500 | p99 latency target (ms) |
| `SLA_AVAILABILITY_TARGET` | 99.5 | Monthly availability (%) |
| `SLA_LEASE_TTL_MINUTES` | 30 | Proposal lease TTL |
| `SLA_MIN_PEER_AVAILABILITY` | 99.0 | Minimum peer availability for federation |
| `SLA_DEGRADED_ERROR_WINDOW_SECONDS` | 30 | Error-rate measurement window (s) |
| `SLA_DEGRADED_ERROR_THRESHOLD_PERCENT` | 10 | Error rate threshold (%) |

**Tier 2 — Runtime DB overrides** (`roadmap.sla_config`):

```sql
SELECT key, value, description, updated_at FROM roadmap.sla_config;
```

Recognized keys:
- `p99_latency_target_ms`
- `degraded_error_threshold_percent`
- `degraded_error_window_seconds`
- `availability_target_percent`
- `rto_minutes`
- `lease_ttl_minutes`
- `min_peer_availability_percent`
- `planned_maintenance_max_hours`

---

## 5. Failure Mode Catalog

| Failure Mode | RTO | RPO | Recovery Path |
|---|---|---|---|
| MCP server process crash | < 5 min | 0 (stateless) | Systemd auto-restart; PID watchdog |
| Postgres graceful restart | < 5 min | 0 (WAL sync write) | Connection pool auto-reconnect |
| Network partition MCP↔Postgres | < 5 min | 0 | Pool exponential retry; Down state fires |
| Agent registry stale entries | < 30 min | Last heartbeat interval | Agents re-register on reconnect |
| MCP tool handler panic | < 1 min | 0 | Per-call error boundary; process supervisor restarts |
| Postgres data corruption | **Excluded** (HA roadmap) | N/A | Requires WAL archiving + HA (future) |
| Full host failure | **Excluded** (HA roadmap) | N/A | Roadmap goal: < 2 min with HA Postgres |

Exclusions are explicit omissions. HA targets are roadmap goals only.

---

## 6. Rollback Clause

All P081 artifacts are additive. Rollback procedure:

1. Drop migration tables: `DROP TABLE roadmap.sla_config; DROP TABLE roadmap.sla_events;`
2. Remove `sla_health_check` from `opsRoutes` in `consolidated.ts`
3. Remove `/metrics` and `/api/sla` routes from `src/apps/server/index.ts`
4. Remove latency timing from `callTool()` in `src/apps/mcp-server/server.ts`
5. Remove `prom-client` dependency
6. Revert WebSocket `sla_state_change` LISTEN in `websocket-server.ts`

No FK cascade impact. SLA targets should be reviewed after first production deployment with real traffic baseline replacing Appendix A synthetic measurements.

---

## 7. Error Budget Ownership

| Surface | Budget Owner | Escalation Channel |
|---|---|---|
| MCP API latency | MCP server maintainer | #alerts |
| Platform availability | Platform ops / orchestrator | #alerts, incident log |
| Lease TTL compliance | Control plane | #alerts |
| Postgres RTO | Infrastructure | #alerts, incident log |

---

## 8. Escalation Procedures

| Channel | Purpose |
|---|---|
| `#ops` | Planned maintenance announcements (≥ 24 h advance notice required) |
| `#alerts` | Automated SLA state change notifications (Degraded, Down) |
| `#incidents` | Formal incident tracking when Down state persists > 10 min |

| Tier | Trigger | Action | Response Target |
|---|---|---|---|
| T0 — Self-healing | State transition detected | Auto-log `sla_events`, fire `#alerts` | Immediate (automated) |
| T1 — Operator alert | Degraded > 5 min OR Down entered | Operator on-call paged | Acknowledge within 5 min |
| T2 — Incident | Down > 10 min OR budget > 50% consumed | Formal incident in proposals | Lead assigned within 15 min |
| T3 — Emergency | Down > 30 min OR budget 100% consumed | Halt new lease grants; escalate | Platform lead within 30 min |

Response commitments are internal SRE targets, not customer-facing guarantees.

---

## 9. SLA Review Cadence

| Trigger | Action |
|---|---|
| First production deployment | 30-day post-deploy review; real traffic baseline replaces Appendix A synthetic; version → 1.1 |
| Quarterly (every 90 days) | Compare actual vs. target from `sla_events`; update if sustained > 20% divergence |
| Error budget > 80% consumed | Ad-hoc review; root cause analysis; target reassessment |
| Major architectural change | Impact assessment; evaluate whether targets remain valid |

Review authority: Platform lead + surface owners. Version scheme: semver.

---

## 10. MCP `sla_health_check` Tool

Registered as action `sla_health_check` on `mcp_ops`. Returns:

```json
{
  "state": "Normal | Degraded | Down",
  "sla_version": "1.0.0",
  "metrics": {
    "p99_latency_ms": 45.2,
    "error_rate_30s": 0.0,
    "error_rate_5m": 0.1,
    "active_agents": 3,
    "sample_count_5m": 120
  },
  "breached_slos": [],
  "since": "2026-06-02T20:00:00Z",
  "thresholds": {
    "p99_latency_target_ms": 500,
    "error_threshold_percent": 10
  }
}
```

If Postgres is unreachable: `{ "state": "Down", "error": "postgres_unreachable", ... }` — never silently wrong.

---

## 11. Prometheus Metrics Endpoint

`GET /metrics` — Prometheus text format (Content-Type: `text/plain; version=0.0.4`).

```
# HELP agenthive_mcp_call_duration_seconds MCP tool call latency histogram (seconds)
# TYPE agenthive_mcp_call_duration_seconds histogram
agenthive_mcp_call_duration_seconds_bucket{le="0.1"} <N>
agenthive_mcp_call_duration_seconds_bucket{le="0.5"} <N>
agenthive_mcp_call_duration_seconds_sum <S>
agenthive_mcp_call_duration_seconds_count <C>

# HELP agenthive_mcp_error_rate MCP error rate — 30-second rolling window (0-1)
# TYPE agenthive_mcp_error_rate gauge
agenthive_mcp_error_rate <value>

# HELP agenthive_availability_ratio Platform availability ratio — 30-day rolling (0-1)
# TYPE agenthive_availability_ratio gauge
agenthive_availability_ratio <value>

# HELP agenthive_sla_state Current platform SLA state: 0=Normal 1=Degraded 2=Down
# TYPE agenthive_sla_state gauge
agenthive_sla_state <0|1|2>
```

Data source: `roadmap.trace_span` (operation = `mcp_tool_call`). Metrics are computed at scrape time.

`GET /api/sla` — returns `docs/sla-contract.json` verbatim (schema: `agenthive-sla/v1`).

---

## 12. CLI and Dashboard

**CLI:**
```bash
hive sla                   # Display SLA state (exit 0=Normal, 1=Degraded, 2=Down)
hive sla --format json     # Machine-readable output
```

**Dashboard:** WebSocket clients receive `sla_state` push messages on state transitions via `pg_notify('sla_state_change', ...)`.

---

## Appendix A: Baseline Measurement Data

### Measurement Methodology

**Pre-P081 baseline (before 2026-06-02):**  
No MCP tool call latency instrumentation existed in `roadmap.trace_span`. The `callTool()` method in `src/apps/mcp-server/server.ts` did not write timing data. This appendix records the first available measurements.

**Instrumentation added:** P081 adds `process.hrtime.bigint()` timing to `callTool()` and writes each call as a `operation='mcp_tool_call'` span to `roadmap.trace_span`. All measurements below are **post-P081 instrumentation** and reflect real production traffic.

---

### Existing Orchestration Baselines (from `roadmap.trace_span`, 2026-05-06 – 2026-06-03)

These are NOT MCP API latency measurements — they are orchestrator-internal operations recorded in the same table. They establish the DB write performance baseline.

| Operation | Samples | Avg (ms) | p95 (ms) | p99 (ms) | Date Range |
|---|---|---|---|---|---|
| `offer_claimed` | 38,290 | 16.8 | 56.7 | 199.6 | 2026-05-20 – 2026-06-03 |
| `offer_activated` | 34,307 | 18.5 | 63.8 | 200.5 | 2026-05-20 – 2026-06-03 |
| `offer_posted` | 19,924 | 28.0 | 96.4 | 301.9 | 2026-05-20 – 2026-06-03 |
| `offer_completed` | 12,771 | 27,853.6 | 104,665.1 | 600,001.8 | 2026-05-20 – 2026-05-22 |
| `agent.spawn` | 24,680 | 159,826.8 | 684,220.3 | 2,155,048.7 | 2026-05-06 – 2026-06-03 |
| `orch.gate` | 116 | 837,330.3 | 2,367,750.4 | 3,173,332.7 | 2026-05-06 – 2026-05-21 |

**Observation:** Short orchestration operations (offer_claimed, offer_posted) have p99 under 300 ms. Agent spawning and gate evaluations are intentionally long-running (seconds to minutes) — these are NOT subject to the 500 ms MCP API SLO.

---

### MCP Tool Call Baseline (post-P081)

MCP tool call latency data will be populated in `roadmap.trace_span` starting from the P081 merge. To query the current baseline:

```sql
SELECT
  percentile_cont(0.95) WITHIN GROUP (
    ORDER BY (attributes->>'duration_ms')::float
  ) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (
    ORDER BY (attributes->>'duration_ms')::float
  ) AS p99_ms,
  count(*) AS samples,
  min(started_at) AS first_sample,
  max(started_at) AS last_sample
FROM roadmap.trace_span
WHERE operation = 'mcp_tool_call'
  AND started_at > now() - interval '24 hours';
```

**SLA target rationale:** The 500 ms p99 target is set conservatively based on:
1. DB-backed operations (offer_claimed p99 = 199.6 ms) leave ~300 ms budget for MCP parsing and handler logic
2. Industry standard for synchronous API calls (comparable systems target 200–500 ms p99 at 100 concurrent users)
3. Target will be reviewed after first 30 days of production instrumentation per §9 review cadence

**Provenance:** Pre-P081 synthetic baseline. Marked for replacement with real-traffic data after first production deployment.

---

*End of SLA Contract v1.0.0*
