# AgentHive Platform SLA Contract

**Version:** 1.0  
**Effective Date:** 2026-05-29  
**Scope:** AgentHive control-plane services running on a single-host deployment  
**Proposal:** P081

---

## 1. Availability Formula (AC-6)

**Monthly Availability** is measured over a rolling calendar month:

```
availability = (total_minutes - downtime_minutes) / total_minutes × 100
```

**Definitions:**
- **Downtime:** Any period where the MCP API or Postgres returns errors on >50% of requests for a continuous window ≥ 60 seconds.
- **Planned maintenance:** Excluded from downtime if announced ≥ 30 minutes in advance via the channel system `platform.maintenance`. Up to 60 minutes/month of planned maintenance is excluded by default.
- **Partial outage:** A period where a single surface (e.g. agent registry reads) is degraded but the MCP API itself remains reachable counts as 50% weight toward downtime minutes.
- **Measurement:** Computed from `roadmap.trace_span` (operation='mcp_tool_call') and system health probes. A 5-minute gap in span data is treated as a potential outage interval requiring manual review.

**Target:** ≥ 99.5% monthly availability (~3.6 hours/month maximum downtime)

---

## 2. SLA Targets (AC-1)

| Surface | Metric | Target | Window |
|---------|--------|--------|--------|
| MCP API | p99 call latency | < 500ms | Rolling 5-min (roadmap.trace_span) |
| MCP API write calls | Error rate | < 10% | Rolling 30s window |
| Platform | Monthly availability | ≥ 99.5% | Calendar month |
| Postgres | Restart RTO | < 5 min | Single-node systemd watchdog |
| Lease renewal | Expiry gap | < TTL + 30s | Heartbeat interval |
| Proposal workflow | State transition p99 | < 2s | roadmap.proposal_lifecycle_event |
| Concurrent agents | Baseline capacity | 100 agents | Steady-state fleet |
| Lease TTL | Default | 30 min | Configurable via roadmap.sla_config |

---

## 3. Platform State Definitions (AC-2)

### Normal
- p99 MCP tool call latency ≤ 500ms (5-min window)
- Error rate ≤ 10% (30s window)
- Postgres reachable and responsive
- Agent fleet heartbeats current (stale fraction < 20%)

**Transition to Degraded:** Any threshold breach sustained for ≥ 30 seconds.

### Degraded
- p99 latency > 500ms **OR** error rate > 10% over 30s window **OR** ≥ 20% of fleet agents stale
- Postgres reachable but slow (query latency > 1s p50)
- Proactive notifications sent to registered agents via `platform.alerts` channel

**Transition to Normal:** All thresholds within bounds for 60 consecutive seconds.  
**Transition to Down:** Postgres unreachable **OR** error rate > 50% for > 60 seconds.

### Down
- MCP API returning errors on > 50% of requests
- Postgres connection refused or all pool connections exhausted
- Manual operator intervention required

**Recovery:** After fix, state transitions Normal only after 60s clean window.

---

## 4. Failure Mode Inventory (AC-9)

| Failure Mode | Detection | RTO Target | RPO Target | Notes |
|---|---|---|---|---|
| MCP server process crash | systemd watchdog + heartbeat gap | < 5 min | 0 (stateless) | Auto-restart via systemd |
| Postgres connection pool exhaustion | pgbouncer_stats cl_waiting spike | < 5 min | 0 | PgBouncer max_client_conn limit |
| Postgres primary restart | connection refused errors | < 5 min | WAL-based, typically 0 | Single-node; no replica |
| Postgres data corruption | Startup errors in pg logs | Excluded — requires restore | Last pg_dump backup | RPO = backup interval |
| Agent registry unavailability | Fleet status degraded | < 2 min | 0 (re-registers on restart) | Agents re-register on boot |
| Network partition (host isolated) | Heartbeat gap in orchestrator | N/A (manual) | Excluded | Single-host deployment |
| Disk full | Write errors in trace_span | < 30 min (alert) | Excluded from SLA | Monitor disk via OS metrics |
| Memory exhaustion (OOM) | systemd OOM kill + restart | < 5 min | 0 | Node.js heap tuning applies |
| Migration failure | Service start failure | Excluded from uptime SLA | Last known good schema | Rollback via migration revert |

---

## 5. Alerting Thresholds (AC-5, AC-8)

Thresholds are stored in `roadmap.sla_config` (key-value store) and read at runtime by the `health_check` MCP tool. Default values:

| Config Key | Default | Description |
|---|---|---|
| `latency_p99_ms_threshold` | 500 | p99 latency threshold (ms) triggering Degraded |
| `error_rate_pct_threshold` | 10 | Error rate % threshold triggering Degraded |
| `error_window_seconds` | 30 | Rolling window for error rate measurement |
| `latency_window_seconds` | 300 | Rolling window for latency p99 measurement (5 min) |
| `degraded_sustain_seconds` | 30 | Seconds a breach must persist before state changes |
| `stale_agent_pct_threshold` | 20 | % of stale agents triggering Degraded |
| `lease_ttl_minutes` | 30 | Default lease TTL for all proposal types |
| `alert_channel` | platform.alerts | NOTIFY channel for SLA breach notifications |
| `maintenance_channel` | platform.maintenance | NOTIFY channel for maintenance announcements |

Thresholds are configurable at runtime:
```sql
UPDATE roadmap.sla_config
SET value = '1000', updated_at = now()
WHERE key = 'latency_p99_ms_threshold';
```

---

## 6. Prometheus Metrics (AC-4)

Exposed at `GET /metrics` in Prometheus text format. No external dependency required — metrics are computed from existing DB tables.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `agenthive_platform_availability` | Gauge | — | 1=Normal, 0.5=Degraded, 0=Down |
| `agenthive_active_agents` | Gauge | — | Count of healthy agents from fleet |
| `agenthive_active_leases` | Gauge | — | Active proposal leases |
| `agenthive_mcp_latency_p99_ms` | Gauge | — | p99 MCP tool call latency (ms), rolling 5-min window |
| `agenthive_mcp_error_rate_pct` | Gauge | — | Error rate % (rolling 30s window) |

Also available at `GET /api/sla` — returns JSON with current SLA state and all metric values.

---

## 7. Baseline Measurements (AC-7)

Baseline collected 2026-05-29 from `roadmap.trace_span` (operation='mcp_tool_call'). Pre-P081, no systematic latency instrumentation existed; estimates are from `tool_invocation_log` timestamps:

| Metric | Observed Value | Notes |
|---|---|---|
| p50 MCP tool call latency | ~25ms | Estimated from log timestamps |
| p99 MCP tool call latency | ~180ms | Estimated; no load at measurement time |
| Error rate (7-day) | ~0.3% | From tool_invocation_log error counts |
| Monthly availability | >99.9% | No recorded outages in last 30 days |
| Active agents (steady state) | 8–15 | From agent_health heartbeats |
| Active leases | 5–20 | Varies with proposal load |

**Note:** These baselines reflect a low-traffic development environment. Production targets are conservative to accommodate burst traffic from orchestrator spawning 50–100 agents concurrently. Instrumentation via P081 will produce accurate baselines within 24h of deployment.

---

## 8. SLA Breach Response

1. **Detection:** `health_check` MCP tool returns `state: "Degraded"` or `state: "Down"`
2. **Notification:** NOTIFY sent to `platform.alerts` channel with structured payload
3. **Operator action:** Within RTO window, restart affected service via systemd
4. **Post-incident:** File proposal in AgentHive with root cause analysis within 24h
5. **SLA credit:** This is an internal contract; no external SLA credits apply

---

## 9. References

- P044: Platform vision document (references this SLA contract)
- P063: Observability stack (Prometheus + trace_span foundation)
- P604: Observability schema (roadmap.trace_span, roadmap.agent_execution_span)
- `roadmap.sla_config`: Runtime configuration table (migration 181)
- `roadmap.sla_events`: SLA breach event log (migration 181)
- MCP tool: `mcp_ops action=health_check` — live SLA state
- HTTP: `GET /api/sla` — machine-readable SLA state (JSON)
- HTTP: `GET /metrics` — Prometheus exposition format
