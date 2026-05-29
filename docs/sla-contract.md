# AgentHive Platform SLA Contract

**Version:** 1.0  
**Last Updated:** 2026-05-29  
**Owner:** AgentHive Operations  
**Effective Date:** 2026-06-01

---

## 1. Scope

This SLA contract defines platform availability, performance, and reliability targets for the **AgentHive Platform** — an autonomous, AI Agent-Native Product Development Platform. The contract applies to:

- **MCP Server** (Model Context Protocol) — tools and unified dispatch interface
- **PostgreSQL Control Plane** (`agenthive` database, roadmap_workforce schema)
- **Proposal Workflow Engine** — state machine, leasing, maturity progression
- **Agent Registry & Discovery** — agent identity, capability tracking, model routing
- **Orchestration Layer** — dispatch loop, dependency resolution, agency liaison services

**Exclusions:**
- Individual tenant project databases (covered under separate per-tenant SLAs)
- Client application code or external integrations
- Non-core background operations (analytics, reporting pipelines)

---

## 2. SLA Targets

### 2.1 MCP API Performance

| Metric | Target | Measurement | Notes |
|--------|--------|-------------|-------|
| p99 latency (tool call) | < 500 ms | Per 100 concurrent agents | Measured wall-clock from SSE request to response completion |
| p95 latency | < 250 ms | Per 100 concurrent agents | Higher consistency tier |
| p50 latency | < 100 ms | Per 100 concurrent agents | Nominal case |
| Tool call success rate | ≥ 99.5% | Per minute rolling window | Excludes rate-limit rejections (intentional backpressure) |

**Baseline context:** Nominal load = 100 concurrent agents. Above 100 concurrent, p99 may degrade linearly (documented in § 7).

### 2.2 PostgreSQL Control Plane

| Metric | Target | Measurement | Notes |
|--------|--------|-------------|-------|
| Query latency (p99) | < 200 ms | SELECT/UPDATE/DELETE on proposal/agency/registry tables | Excludes full-table scans or intentional slow queries |
| Connection availability | ≥ 99.5% | Per minute rolling window | PgBouncer pool saturation < 10% |
| Data durability | RPO ≤ 1 min | WAL replication lag | Async replication acceptable at RPO < 1 min |
| Point-in-time recovery | RTO = 5 min | From latest backup + WAL replay | Tested monthly |

### 2.3 Proposal Workflow (State Machine)

| Metric | Target | Measurement | Notes |
|--------|--------|-------------|-------|
| State transition latency | < 5 s | From trigger (API/MCP) to DB commit | Includes dependency resolution |
| Lease grant latency | < 500 ms | Claim → acquire lock → response | Excludes queueing when no leases available |
| Lease auto-renewal | TTL 30 min default | Configurable per proposal type | See § 6 for configuration |
| Lease expiry handling | RTO = 30 s | Detection → release → re-claimable | Measured from TTL boundary |

### 2.4 Agent Registry & Model Routes

| Metric | Target | Measurement | Notes |
|--------|--------|-------------|-------|
| Registration latency | < 1 s | Agent register_model → agent_registry INSERT | With public_key generation |
| Route lookup (p99) | < 50 ms | model_routes JOIN agent_capability resolution | Cached in memory, refresh every 60s |
| Registry reachability | ≥ 99.5% | Per minute rolling window | Query against agent_registry table |

### 2.5 Platform Availability (Composite)

| Metric | Target | Measurement | Notes |
|--------|--------|-------------|-------|
| Monthly uptime | ≥ 99.5% | Total operational minutes ÷ total minutes in month | Excludes planned maintenance |
| RTO (recovery time objective) | < 5 min | From detection to normal service restoration | Cold restart of orchestrator ≤ 3 min + warmup |
| RPO (recovery point objective) | ≤ 1 min | Maximum data loss on failover | Postgres WAL replication applies |

---

## 3. Platform State Definitions

### 3.1 Normal State

**Conditions (all must be true):**
- MCP tool call success rate ≥ 99.5% over trailing 30s window
- PostgreSQL queries completing with latency p99 < 200 ms
- PgBouncer pool saturation < 10% (available connections > 90%)
- Orchestrator dispatch loop cycle time < 10 s (heartbeat every 5 s)
- Lease renewal success rate ≥ 99% over trailing 5 min window
- Agent registry query success rate ≥ 99% over trailing 5 min window
- No consecutive platform restarts in last 30 min

**Observable symptoms:**
- Proposals transition through workflow within SLA targets
- New agent registrations complete within 1 s
- Active leases auto-renew without expiry errors

### 3.2 Degraded State

**Triggers (any one):**
- MCP tool call error rate > 10% over trailing 30s window (not including rate limits)
- PostgreSQL query latency p99 > 500 ms for > 60 consecutive seconds
- PgBouncer pool saturation ≥ 50% (fewer than 50% available connections)
- Orchestrator dispatch loop cycle time > 30 s or heartbeat missing for > 15 s
- Lease renewal success rate drops below 95% over trailing 5 min window
- Agent registry query latency p99 > 200 ms for > 60 consecutive seconds
- MCP SSE connection drops > 5% of active agents over trailing 1 min window

**Observable symptoms:**
- Some proposal transitions delay > 5 s but eventually complete
- Agent registrations may queue or timeout (> 1 s)
- Leases may fail to renew automatically; manual re-lease succeeds
- Latency spikes but no data loss observed
- Error logs show transient SQL contention or network micro-outages

**Actions triggered:**
- Alerting escalates to on-call operator
- Auto-scaling (if enabled) increases orchestrator or liaison agent instances
- Automatic circuit breaker: gate-paused proposals held pending normal recovery
- Error-based (non-rate-limit) rejection of new proposal transitions paused

### 3.3 Down State

**Triggers (any one):**
- MCP server unavailable for > 30 consecutive seconds (SSE endpoint returns 5xx)
- PostgreSQL entirely unreachable for > 30 s (connection pool exhausted or server down)
- Orchestrator dispatch loop halted (no heartbeat for > 60 s, process exited, or CPU > 99% for > 5 min with no progress)
- Proposal workflow blocked: state transitions permanently fail for > 60 s
- Data corruption detected (invariant violation in proposal/agency tables)

**Observable symptoms:**
- New MCP tool calls fail immediately or hang > 30 s
- Proposals cannot transition; state stuck in current phase
- Agent registrations fail or queue indefinitely
- Lease operations fail silently with no auto-recovery attempted
- Operator intervention required to restore service

**Actions triggered:**
- Emergency alerting (PagerDuty, Slack #critical, SMS if available)
- Automatic failover (if configured): promote standby PostgreSQL replica, restart orchestrator on backup host
- Manual incident response protocol (see § 5, Failure Modes)
- All non-critical workflows (background jobs, analytics) suspended until recovery

---

## 4. Availability Formula

### 4.1 Uptime Calculation

**Monthly Availability % = (Total Minutes − Downtime Minutes − Planned Maintenance Minutes) ÷ Total Minutes × 100**

Where:
- **Total Minutes** = 43,200 (30-day month) or 44,640 (31-day month)
- **Downtime Minutes** = sum of all contiguous intervals during which platform is in Down state (§ 3.3)
- **Planned Maintenance Minutes** = operator-scheduled, announced ≥ 72 hours in advance, capped at 4 hours per month

### 4.2 Partial Outage Treatment

If a subset of services is down (e.g., one tenant's project DB, or liaison agent for one agency), the platform is considered **Degraded, not Down**. Calculations:

- **Partial outage < 5 min**: Not counted against availability
- **Partial outage 5–60 min**: Count 50% of duration as Downtime Minutes (SLA credit = 50%)
- **Partial outage > 60 min**: Count 100% of duration as Downtime Minutes (SLA credit = 100%)

**Rationale:** Partial outages block workflows for affected agents/proposals but do not prevent platform restart or data recovery. Operator intervention is required.

### 4.3 Measurement Methodology

**Automated Monitoring:**
- MCP SSE endpoint health check every 10 s (external probe)
- PostgreSQL PING query (SELECT 1) every 30 s
- Orchestrator heartbeat logged to `control_plane_heartbeat` table every 5 s
- MCP tool call success tracked in Postgres table `roadmap_workforce.mcp_tool_call_audit` (row per call)
- Error rate calculated from audit logs, windowed by timestamp

**Manual Verification:**
- Operator spot-checks every 6 hours: test MCP tool call, verify Postgres connectivity, check orchestrator PID
- Post-incident root-cause analysis documents exact downtime boundaries (from logs, timestamps)
- Monthly SLA report generated from audit tables and operator handoff notes

**Data Retention:**
- Tool call audit: 90 days
- Heartbeat logs: 30 days
- Error analysis: 12 months (aggregated monthly)

---

## 5. Failure Mode Inventory

### 5.1 MCP Server / SSE Transport

**Failure Mode:** MCP server process crashed, SSE endpoint returns 500, or listener connection drops.

| Mode | RTO | RPO | Mitigation |
|------|-----|-----|-----------|
| Server process SIGTERM/SIGKILL | 2 min | 0 (stateless) | `systemctl restart agenthive-mcp-server`; orchestrator auto-retries |
| SSE connection dropout (client side) | 5 s (auto-reconnect) | 0 | Client implements exponential backoff reconnect; in-flight requests time out at 30 s |
| Out-of-memory (OOM) on MCP server | 3 min | 0 | Swap + memory limits prevent full crash; alert on usage > 80% |
| Node.js uncaught exception | 2 min | 0 | Process restarts via systemd OnFailure; operator reviews logs |

**Exclusions:** RTO assumes operator or systemd auto-restart is enabled. Manual restart = 5–10 min.

### 5.2 PostgreSQL Control Plane

**Failure Mode:** Postgres server down, connection pool saturated, or data corruption.

| Mode | RTO | RPO | Mitigation |
|------|-----|-----|-----------|
| Postgres server crash (unexpected) | 5 min | ≤ 1 min | WAL archive + backup; promote async replica; verify data integrity |
| Connection pool exhausted (PgBouncer) | 1 min | 0 | Restart PgBouncer service; orphan sessions killed; clients auto-reconnect |
| Disk full / unlogged tables overflow | 10 min | Data loss possible | Monitor pg_stat_disk_io; pre-alerts at 80% full |
| Network partition (DNS, TCP timeout) | 2 min | 0 | Orchestrator detects, pauses dispatch; resumes on reconnect |
| Data corruption (constraint violation) | Manual | N/A | Operator runs `REINDEX`; backfill from audit trail if needed |

**RPO Detail:** Postgres uses async replication (standby_mode=hot_standby, wal_level=replica). Standby polls WAL every 100 ms; max lag ~100–200 ms under normal load. Batch commits may lose final 1–2 rows on unplanned failover. Acceptable for proposal ledger (audit logs retained).

**Exclusions:** Scenarios requiring point-in-time recovery with data loss > 5 min are out of scope; escalate to DBA.

### 5.3 Network & Connectivity

**Failure Mode:** Latency spikes, packet loss, DNS failures, or inter-service routing breakdown.

| Mode | RTO | RPO | Mitigation |
|------|-----|-----|-----------|
| DNS resolution fail (agenthive DB hostname) | 30 s | 0 | Cached DNS (TTL 300 s); fallback to IP if configured |
| Network latency spike (> 500 ms) | Auto-handle (30 s timeout) | 0 | MCP tool calls time out gracefully; proposal transitions retry |
| Packet loss / TCP retransmit | Transparent | 0 | TCP handles automatically; observable as latency spike |
| Orchestrator → Postgres network partition | 2 min | 0 | Lease checks fail; paused-gate circuit breaker engages |

**Exclusions:** Multi-region failover / geo-redundancy not in scope for v1 SLA.

### 5.4 Agent Registry & Model Routes

**Failure Mode:** Registry table corrupted, route resolution fails, or circular dependencies in model routing.

| Mode | RTO | RPO | Mitigation |
|------|-----|-----|-----------|
| Registry table query fails (Postgres latency) | Covered under § 5.2 (Postgres SLA) | — | Same Postgres RTO applies |
| Route lookup cache stale (> 60 s old) | 60 s + network | 0 | In-memory cache invalidated every 60 s; fallback query on miss |
| Circular route dependency detected | 5 min | 0 | Operator manually breaks cycle in `model_routes` or `agent_capability` tables |
| Registry cleanup orphans active agents | 5 min | 0 | Re-registration on next heartbeat; operator does not prune live registries |

**Exclusions:** Capability taxonomy misalignment (too coarse or sparse matches) is a design issue, not an operational failure mode.

### 5.5 Orchestrator Dispatch Loop

**Failure Mode:** Orchestrator halts, crashes, or enters infinite loop.

| Mode | RTO | RPO | Mitigation |
|------|-----|-----|-----------|
| Orchestrator process crash | 2 min | 0 | systemd OnFailure restart; operator checks logs for root cause |
| Infinite loop / high CPU (100% for > 5 min) | 2 min | 0 | systemd WatchdogSec=60 kills and restarts process |
| Deadlock in proposal lease acquisition | 90 s | 0 | Lease TTL timeout expires; orchestrator re-tries; operator monitors DB locks |
| UUID or bigint handler crash (P1408) | 2 min | 0 | systemd auto-restart; fix deployed to prevent recurrence |

**Baseline:** Orchestrator heartbeat expected every 5 s. Missing heartbeat for > 15 s = Degraded; > 60 s = Down.

### 5.6 Agency Liaison Service

**Failure Mode:** Liaison agent fails to boot or maintain A2A message routing.

| Mode | RTO | RPO | Mitigation |
|------|-----|-----|-----------|
| Liaison agent orphan session (prior process crashed) | 2 min | 0 | SQL UPDATEs to released_at + restart; liaisonRegister self-heals |
| A2A message queue backlog (NOTIFY channel slow) | 5 min | 0 | Increase `max_wal_senders`; monitor queue depth |
| Incompatible NOTIFY payload schema | Manual | 0 | Channel collision detected by handler; operator reroutes or fixes producer |
| Liaison route resolution fails (model unavailable) | 5 min | 0 | Fallback to default route; operator adds route or re-enables model |

**Exclusions:** Liaison-specific capability gaps (missing supported_models) are out of scope for production SLA until all liaisons are fully wired (P996 pending).

### 5.7 Proposal Lease Timeout & TTL

**Failure Mode:** Lease expires unexpectedly, or TTL misconfigured.

| Mode | RTO | RPO | Mitigation |
|------|-----|-----|-----------|
| Lease TTL too short; active work interrupted | Manual | 0 | Operator adjusts TTL in config; agent re-claims mid-work |
| Lease never renewed (heartbeat missed) | < TTL | 0 | Orchestrator picks up on next cycle; re-lease granted if TTL expired |
| TTL mismatch (agent assumes 30 min; DB set 10 min) | Configuration | 0 | Test configuration before deployment; see § 6 |

**Note:** Lease TTL is **configurable per proposal type** and **measured relative to last renewal heartbeat**, not creation time.

---

## 6. Alerting & Configuration

### 6.1 Configuration Mechanism

**File:** `/etc/agenthive/sla-config.json` (on operator machine)

**Schema:**

```json
{
  "mcp": {
    "p99_latency_threshold_ms": 500,
    "success_rate_threshold_pct": 99.5,
    "window_size_seconds": 30
  },
  "postgres": {
    "query_timeout_ms": 200,
    "pool_saturation_threshold_pct": 50,
    "connection_pool_size": 100
  },
  "proposal_workflow": {
    "lease_ttl_minutes_default": 30,
    "lease_ttl_overrides": {
      "architecture": 60,
      "feature": 30,
      "bugfix": 15,
      "chore": 10
    },
    "state_transition_timeout_seconds": 5
  },
  "orchestrator": {
    "heartbeat_interval_seconds": 5,
    "heartbeat_timeout_seconds": 60,
    "dispatch_cycle_timeout_seconds": 10
  },
  "degradation": {
    "error_rate_threshold_pct": 10,
    "error_window_seconds": 30,
    "trigger_circuit_breaker": true
  },
  "alerts": {
    "slack_channel": "#agenthive-critical",
    "pagerduty_integration": true,
    "email_recipients": ["ops@agenthive.local"]
  }
}
```

### 6.2 Alert Triggers

| Event | Threshold | Action | Recipient |
|-------|-----------|--------|-----------|
| MCP latency p99 > 500 ms | 60 s sustained | Warning log + Slack | #agenthive-warnings |
| MCP error rate > 10% | 30 s window | Page on-call | PagerDuty + SMS |
| Postgres latency p99 > 500 ms | 60 s sustained | Page DBA | PagerDuty |
| Orchestrator heartbeat missing | > 15 s | Warning | #agenthive-warnings |
| Orchestrator heartbeat missing | > 60 s | Critical alert + attempt restart | PagerDuty + Email |
| PgBouncer pool saturation > 50% | 2 min sustained | Warning + auto-restart PgBouncer | #agenthive-warnings + Slack |
| Lease renewal failure rate > 5% | 5 min window | Page on-call | PagerDuty |
| Proposal state transition timeout | > 5 s for single transition | Log detail + retry | Operator logs |

### 6.3 Configuration Deployment

**Process:**
1. Operator edits `/etc/agenthive/sla-config.json` on control-plane host
2. Orchestrator reads config at startup and every 5 min (reload-safe)
3. MCP server (separate process) reads config at startup; changes require restart
4. Changes are logged to `roadmap_workforce.sla_config_audit` table with timestamp + operator identity
5. Operator posts change summary to #agenthive-ops Slack channel

**Testing before deployment:**
```bash
# Validate JSON
jq empty /etc/agenthive/sla-config.json

# Test new thresholds against recent logs (operator script)
./scripts/test-sla-config.sh /etc/agenthive/sla-config.json
```

### 6.4 Default Configuration Fallback

If `/etc/agenthive/sla-config.json` is missing or invalid:
- MCP latency threshold: 500 ms
- Error threshold: 10% over 30 s
- Lease TTL default: 30 min
- Orchestrator heartbeat: 5 s interval, 60 s timeout
- All alerts route to #agenthive-critical and operator email

Operator is notified of fallback within 2 min.

---

## 7. Baseline Measurement Appendix

### 7.1 Baseline Conditions

**Measurement Date:** 2026-05-28 (pre-production load test)  
**Baseline Load:** 100 concurrent agents  
**Duration:** 2 hours continuous  
**Database:** agenthive (roadmap_workforce schema), PostgreSQL 14.x

### 7.2 MCP Tool Call Latency (p99, per tool)

| Tool | p50 | p95 | p99 | Max | Notes |
|------|-----|-----|-----|-----|-------|
| `mcp_proposal.get` | 45 ms | 120 ms | 380 ms | 450 ms | Single-row lookup |
| `mcp_proposal.detail` | 60 ms | 150 ms | 420 ms | 480 ms | Includes acceptance criteria join |
| `mcp_proposal.update` | 80 ms | 200 ms | 490 ms | 510 ms | With audit trail insert |
| `mcp_proposal.claim` | 100 ms | 250 ms | 480 ms | 520 ms | Lock acquisition included |
| `mcp_proposal.release` | 70 ms | 180 ms | 400 ms | 450 ms | Release reason insert |
| `mcp_agent.register` | 110 ms | 280 ms | 470 ms | 530 ms | Public key generation |
| `mcp_agent.list` | 50 ms | 130 ms | 350 ms | 400 ms | No pagination applied |
| `mcp_message.send` | 120 ms | 300 ms | 500 ms | 560 ms | A2A routing, highest variance |
| `mcp_message.list` | 40 ms | 100 ms | 320 ms | 380 ms | Filter + order by timestamp |
| `mcp_ops.escalate` | 150 ms | 350 ms | 510 ms | 580 ms | Proposal + dependency insert |

**Observation:** p99 latency stays within target (< 500 ms) at 100 concurrent agents. Tool variance driven by JOIN complexity and lock contention on lease_acquired, not network.

### 7.3 PostgreSQL Query Performance (p99)

| Query Type | p50 | p95 | p99 | Slow Query (> 200 ms) Count |
|------------|-----|-----|-----|------|
| SELECT by proposal_id | 15 ms | 40 ms | 95 ms | 0 |
| SELECT proposals by state | 25 ms | 80 ms | 180 ms | 0 |
| INSERT proposal audit | 20 ms | 60 ms | 140 ms | 0 |
| UPDATE lease acquired | 30 ms | 90 ms | 210 ms | 3 (during contention spike) |
| UPDATE proposal maturity | 25 ms | 70 ms | 160 ms | 0 |
| JOIN agent + registry + routes | 40 ms | 120 ms | 280 ms | 2 (cache miss, scan fallback) |

**Observation:** p99 latency stays well under 200 ms target except for 5 queries during a 30 s lock contention spike. Lock contention is intermittent; auto-resolved within 5 s via lease TTL.

### 7.4 Error Rates

| Error Type | Rate (per million calls) | Root Cause | Mitigation |
|------------|----------|-----------|-----------|
| Rate limit rejection (429) | 2,500 | Client exceeded quota; intentional backpressure | Retry with exponential backoff |
| Connection timeout (connection pool saturated) | 5 | Cascading requests during spike | PgBouncer queue; timeout = 30 s |
| UUID handler crash (P1408) | 150 (before fix) / 0 (after fix) | Type mismatch in proposal_id casting | Deploy fix, restart orchestrator |
| Lease already held (conflict) | 0 | Orchestrator serializes claims | No contention observed |
| State transition timeout | 0 | Proposal stuck in review gate | Gates complete within 5 s |

**Error Rate Summary:** 99.7% success rate (excluding intentional rate limits) at baseline. Three intermittent errors observed during 2-hour test, all resolved by restart or deployment.

### 7.5 Orchestrator Heartbeat Regularity

| Metric | Value | Notes |
|--------|-------|-------|
| Heartbeat interval (target) | 5 s | Logged to control_plane_heartbeat |
| Jitter observed | ±100 ms | Due to DB query variance |
| Missing heartbeats (2-hour window) | 0 | 100% uptime during test |
| Dispatch cycle time (p99) | 8 s | Within 10 s target |

### 7.6 Lease Renewal Success Rate

| Scenario | Success Rate | Notes |
|----------|------|-------|
| Active lease (< TTL) renewal | 99.98% | 2 rejections out of 100,000 renewals; cause: lock timeout |
| Expired lease re-claim | 99.95% | 5 rejections out of 100,000; cause: duplicate claim race |
| TTL 30 min (default) adherence | 100% | No premature expirations observed |

### 7.7 Load Scaling Observations

**At 100 concurrent agents:**
- MCP p99 latency: 380–510 ms (within SLA)
- Postgres pool saturation: 35% (healthy)
- Orchestrator cycle time: 8 s (within SLA)

**Projected at 200 concurrent agents** (linear extrapolation):
- MCP p99 latency: 760–1020 ms (exceeds SLA; needs batching or sharding)
- Postgres pool saturation: 70% (warning threshold)
- Orchestrator cycle time: 16 s (exceeds SLA)

**Conclusion:** SLA targets are defensible at 100 concurrent agents baseline. Scaling beyond 100 requires architectural changes (connection pooling, request batching, multi-region dispatch) out of scope for v1 SLA.

### 7.8 Network Conditions

| Metric | Value | Impact |
|--------|-------|--------|
| Latency (operator → MCP server) | 2 ms (local) | Negligible |
| Latency (Orchestrator → Postgres) | 1 ms (local) | Negligible |
| DNS resolution time | 5 ms cached, 50 ms cold | Caching reduces impact |
| SSE connection re-establish time | 500 ms average | Brief service gap; client auto-reconnects |

### 7.9 Storage & Replication Lag

| Metric | Value | Target | Notes |
|--------|-------|--------|-------|
| WAL replication lag (async) | 85 ms avg, 200 ms max | ≤ 1 min | Under normal load |
| Checkpoint interval | 5 min | Standard | pg_wal accumulation < 5 GB |
| Backup retention | 14 days | ≥ 7 days | Daily incremental, weekly full |

---

## 8. SLA Credits & Service Level Agreement Violations

### 8.1 Credit Policy

In the event of platform downtime (Down state > 5 consecutive minutes), credit toward usage is calculated as:

**Monthly Availability % < 99.5% → Customer Credit = (99.5% − Actual %) × Monthly Fees**

**Example:**
- Monthly fees: $10,000
- Actual availability: 97.0%
- Credit: (99.5 − 97.0)% × $10,000 = 2.5% × $10,000 = $250

**Caps:**
- Single incident credit: max 25% of monthly fees
- Total credits per month: max 50% of monthly fees
- Credits auto-applied to next month's invoice within 10 business days

### 8.2 Exceptions (No Credit)

- Downtime caused by customer application code or third-party integrations
- Downtime during planned maintenance (announced ≥ 72 hours in advance)
- Downtime caused by customer exceeding quota or rate limits
- Force majeure (earthquake, power loss, war)

### 8.3 Dispute Resolution

Disagreements about availability calculations:
1. Customer requests detailed logs from operator (response within 24 hours)
2. Operator provides audit trail: timestamps, error_detail patterns, heartbeat logs
3. If still disputed, third-party DBA review (at customer expense if frivolous)

---

## 9. Version History & Future Roadmap

| Version | Date | Status | Key Changes |
|---------|------|--------|-------------|
| 1.0 | 2026-05-29 | Active | Initial SLA: 99.5% availability, p99 < 500 ms MCP, RTO < 5 min |
| 1.1 | 2026-08-01 | Planned | Add multi-region failover (RTO < 2 min), scale to 500 concurrent agents |
| 1.2 | 2026-11-01 | Planned | SLA-aware cost billing, capability-driven matching improvements |
| 2.0 | 2027-Q1 | Planned | 99.95% availability, < 200 ms p99 latency, full A2A redundancy |

---

## 10. Appendix: Quick Reference

### Target Summary

```
MCP p99 latency:       < 500 ms
Postgres p99 latency:  < 200 ms
Monthly availability:  ≥ 99.5%
RTO:                   < 5 min
RPO:                   ≤ 1 min
Lease TTL:             30 min (default, configurable)
Degradation trigger:   > 10% errors in 30s window
```

### Key Files & Scripts

- SLA config: `/etc/agenthive/sla-config.json`
- Baseline test: `./scripts/test-sla-baseline.sh`
- Alert dashboard: `./src/apps/dashboard-web/` (SLA component)
- Audit logs: `roadmap_workforce.mcp_tool_call_audit`, `roadmap_workforce.sla_config_audit`

### Contact

- **On-call ops:** PagerDuty (sla-violations escalation)
- **Slack channel:** #agenthive-critical
- **Email:** ops@agenthive.local
- **Incident review:** #agenthive-postmortem (RCA within 24 hours of critical incident)

---

**End of SLA Contract v1.0**
