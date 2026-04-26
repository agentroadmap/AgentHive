# P501 Service Impact Matrix

**Scope**: How P501 affects each running agenthive service  
**Timeline**: P501 execution only (no change to service during schema install)  
**Fallback**: All services remain on agenthive until P518 (cutover execution)

---

## Service Connectivity During P501

**Database Connection Model**:
- Services connect via **PgBouncer pool** on port 6432
- env var `AGENTHIVE_DATABASE_URL` defines pool name (e.g., "agenthive")
- PgBouncer routes to backend Postgres on port 5432 based on pool config

**P501 Impact**: hiveControl is created and added to PgBouncer pools, but services **remain on agenthive pool** (env unchanged). No connectivity changes during P501 itself.

---

## Individual Service Profiles

### 1. agenthive-mcp (MCP SSE Server)

**Function**: HTTP SSE endpoint on port 6421; brokers all control-plane queries (proposals, agents, gates, dispatches)  
**DB Queries**: READ (proposal list, gate state, agent registry) + WRITE (leases, transitions, discussions)  
**Current Connection**: agenthive via PgBouncer pool "agenthive"

**P501 Impact**: NONE
- Continues querying agenthive during P501 schema install
- No downtime; no reconnection required
- P502 will shadow reads for parity validation

**Pre-P501 Checklist**:
- [ ] MCP is responding to health checks: `curl http://127.0.0.1:6421/health`
- [ ] No hung connections: `psql -p 6432 postgres -c "SHOW CLIENTS;" | grep agenthive` should show < 50 connections

**Post-P501 Validation** (none required; service unchanged)

---

### 2. agenthive-orchestrator (Event-Driven Agent Dispatcher)

**Function**: Listens to PostgreSQL NOTIFY events; spawns agents based on proposal state transitions  
**DB Queries**: READ (proposal state, agent profiles, dispatch routes) + WRITE (run logs, agent health)  
**Current Connection**: agenthive + LISTEN on roadmap_proposal.proposal_state_transitions channel

**P501 Impact**: NONE
- LISTEN channel on agenthive remains active
- Continues dispatching agents during schema install
- P502 logical replication does not interrupt LISTEN (agenthive remains connected)

**Pre-P501 Checklist**:
- [ ] Orchestrator is healthy: `systemctl status agenthive-orchestrator`
- [ ] LISTEN channel is active: `psql -p 6432 agenthive -c "SELECT pg_listening_channels();" as agenthive_admin` (if psql supports it; else check logs)
- [ ] No proposal state transitions are queued (flush any pending work)

**Post-P501 Validation** (none required; service unchanged)

**Risk**: If P502 replication starts and LISTEN events are not replicated atomically, the orchestrator may miss a state transition. **Mitigation**: P503 validates zero-delta during shadow period, ensuring no missed events.

---

### 3. agenthive-gate-pipeline (Gate Review Worker)

**Function**: Processes gate decision queue; advances proposals through state machine  
**DB Queries**: READ (proposals, gate task templates, decision queue) + WRITE (gate decisions, proposal state)  
**Current Connection**: agenthive via PgBouncer

**P501 Impact**: NONE
- Continues processing gate queue during P501
- No query path changes

**Pre-P501 Checklist**:
- [ ] Gate pipeline is healthy: `systemctl status agenthive-gate-pipeline`
- [ ] No proposals stuck in REVIEW state: `psql -p 6432 agenthive -c "SELECT COUNT(*) FROM roadmap_proposal.proposal WHERE state='REVIEW' AND locked_since < NOW() - INTERVAL '1 hour';" as agenthive_admin`

**Post-P501 Validation** (none required)

---

### 4. agenthive-state-feed (State Change Listener → Discord)

**Function**: LISTEN on pg_notify channels; posts proposal state changes to Discord  
**DB Queries**: READ-only (proposals, agents)  
**Current Connection**: agenthive + LISTEN on multiple channels

**P501 Impact**: NONE
- LISTEN channels remain active on agenthive
- Discord notifications continue uninterrupted

**Pre-P501 Checklist**:
- [ ] State feed is healthy: `systemctl status agenthive-state-feed`
- [ ] Discord webhook is reachable: `curl -I https://discord.com/api/webhooks/[ID]/[TOKEN]` (HTTP 204 = OK)

**Post-P501 Validation** (none required)

---

### 5. agenthive-a2a (A2A Message Dispatcher)

**Function**: Routes agent-to-agent messages; maintains message ledger  
**DB Queries**: READ (agent profiles, channels) + WRITE (message ledger, liaison sessions)  
**Current Connection**: agenthive via PgBouncer

**P501 Impact**: NONE
- Continues routing messages during P501

**Pre-P501 Checklist**:
- [ ] A2A service is healthy: `systemctl status agenthive-a2a`
- [ ] Message ledger is not full: `psql -p 6432 agenthive -c "SELECT COUNT(*) FROM roadmap.message_ledger WHERE delivered_at IS NULL;" as agenthive_admin` should be < 10k

**Post-P501 Validation** (none required)

---

### 6. agenthive-copilot-agency (GitHub Copilot Offer-Claim Worker)

**Function**: Processes GitHub Copilot offer-claim workflow; manages agency profiles  
**DB Queries**: READ (agency, agent registry) + WRITE (agency liaison sessions, claims)  
**Current Connection**: agenthive via PgBouncer

**P501 Impact**: NONE
- Continues processing GitHub Copilot offers during P501

**Pre-P501 Checklist**:
- [ ] Copilot agency is healthy: `systemctl status agenthive-copilot-agency`
- [ ] No stuck claim operations: `psql -p 6432 agenthive -c "SELECT COUNT(*) FROM roadmap_proposal.claim_log WHERE status='pending' AND created_at < NOW() - INTERVAL '1 hour';" as agenthive_admin`

**Post-P501 Validation** (none required)

---

## Service Dependency Readiness Checklist (Pre-P501)

Run this before P501 execution:

```bash
# 1. All services healthy?
systemctl status agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline \
  agenthive-state-feed agenthive-a2a agenthive-copilot-agency

# Expected: 6/6 active (running) [expect some to be active, some inactive if not deployed]

# 2. Database connectivity from each service?
for svc in agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline agenthive-state-feed agenthive-a2a agenthive-copilot-agency; do
  echo "=== $svc ==="
  systemctl show -p ExecStart $svc | grep -o "agenthive\|agenthive_admin" || echo "No explicit user; check env"
done

# Expected: All services use agenthive user or agenthive_admin

# 3. PgBouncer has agenthive pool?
psql -p 6432 -U postgres -d pgbouncer -c "SHOW DATABASES LIKE 'agenthive';"

# Expected:
#     name    | host | port | database | force_user | pool_size | min_pool_size | ...
# agenthive | 127.0.0.1 | 5432 | agenthive | agenthive_admin | 30 | 10 | ...

# 4. MCP is responding?
curl -s http://127.0.0.1:6421/health | jq '.status'

# Expected: "ok" or similar

# 5. No massive backlog in any queue?
psql -p 6432 -U agenthive_admin -d agenthive << 'SQL'
SELECT 'decision_queue' as queue, COUNT(*) as pending
  FROM roadmap_proposal.transition_queue WHERE status='pending'
UNION ALL
SELECT 'agent_runs', COUNT(*) FROM roadmap.agent_runs WHERE status='pending'
UNION ALL
SELECT 'message_ledger_undelivered', COUNT(*) FROM roadmap.message_ledger WHERE delivered_at IS NULL;
SQL

# Expected: All counts < 10k (no massive backlog)
```

---

## Post-P501 Service Validation (none required)

**Why**: P501 does not change service connections. Services remain on agenthive until P518 cutover execution.

**When P502–P503 run** (subsequent proposals):
- Services may experience brief read-shadow noise (extra replicated reads from hiveControl)
- This is transparent; no service code changes needed

**When P505–P518 run** (cutover):
- Services are cut over to hiveControl (env var flip)
- Connection pools reconnect transparently
- No application-level changes needed

---

## Known Caveats & Assumptions

### 1. LISTEN Channels Not Replicated (P502 Risk)

**Issue**: Logical replication does not replicate LISTEN subscriptions. If agenthive-orchestrator and agenthive-state-feed are LISTEN'ing on agenthive channels, those subscriptions are NOT replicated to hiveControl.

**Impact**:
- During P503 shadow phase (services read from both agenthive and hiveControl), LISTEN events only arrive from agenthive
- If a state transition triggers a NOTIFY on agenthive, only services LISTEN'ing on agenthive receive it
- On cutover (P518), services switch to hiveControl env; LISTEN channels must be re-established

**Mitigation**:
- Services re-establish LISTEN channels upon connection pool reset
- Applications use connection pool `idle_in_transaction_session_timeout` to force channel renewal
- P505 runbook includes a "wait 30s for LISTEN re-establishment" step

**Acceptance Criteria**: Post-cutover validation (P518) confirms LISTEN channels active on hiveControl

### 2. In-Flight Transactions (P505 Risk)

**Issue**: If a service has an open transaction to agenthive when P505 cutover begins, the transaction is lost.

**Impact**: Service error, rollback, retry

**Mitigation**:
- All services use sub-minute transaction timeouts (PgBouncer `idle_in_transaction_session_timeout` = 30s default)
- P505 runbook includes "wait for idle state" verification before cutover

**Acceptance Criteria**: No in-flight transactions at T+0 of cutover window

### 3. Connection Pool Recycling

**Issue**: After env flip (cutover), PgBouncer pools to agenthive are still active until connections naturally idle and reconnect.

**Impact**: Brief (< 30s) window where some connections go to old pool (agenthive), some to new (hiveControl)

**Mitigation**:
- P505 includes explicit pool drain: `pg_terminate_backend()` on all agenthive connections after env flip
- PgBouncer RELOAD re-initializes pools
- New connections automatically route to hiveControl

**Acceptance Criteria**: Post-cutover query shows all active connections on hiveControl within 30s

### 4. Agent Heartbeat State (Orchestrator Nuance)

**Issue**: agenthive-orchestrator maintains agent heartbeat state in `roadmap.agent_health`. If an agent dies mid-replication (P502–P503), the orchestrator may not have a consistent view of agent state.

**Impact**: Orchestrator may dispatch to a dead agent; dispatch fails; retry queue builds

**Mitigation**:
- P503 shadow phase runs 48 hours; any agent state flaps are observable
- If inconsistent heartbeats detected, investigate before proceeding to P505

**Acceptance Criteria**: P503 detects zero flaps in agent_health during 48h tail

---

## Service Restart Procedure (for P518 Cutover)

**When**: After env var flip to hiveControl  
**Who**: Operator (automated via deployment system)  
**Time**: < 1 minute total

```bash
# Step 1: Graceful shutdown (connections drain)
for svc in agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline \
           agenthive-state-feed agenthive-a2a agenthive-copilot-agency; do
  systemctl stop $svc
done
# Wait 10s for connections to close

# Step 2: Restart (connects to new hiveControl env)
for svc in agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline \
           agenthive-state-feed agenthive-a2a agenthive-copilot-agency; do
  systemctl start $svc
done

# Step 3: Verify startup
for svc in agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline \
           agenthive-state-feed agenthive-a2a agenthive-copilot-agency; do
  systemctl is-active $svc && echo "$svc OK" || echo "$svc FAILED"
done

# Step 4: Health checks
sleep 5
curl -s http://127.0.0.1:6421/health | jq '.status'
```

---

## Fallback Procedure (if cutover fails)

**When**: P505 cutover aborts (Escalation Contact decision)  
**Who**: Operator  
**Time**: < 2 minutes

```bash
# Step 1: Revert env to agenthive
AGENTHIVE_DATABASE_URL=postgresql://agenthive_admin:${PASS}@127.0.0.1:5432/agenthive
# (edit /etc/agenthive/env or systemd EnvironmentFile)

# Step 2: Restart services
for svc in agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline \
           agenthive-state-feed agenthive-a2a agenthive-copilot-agency; do
  systemctl restart $svc
done

# Step 3: Verify on agenthive
curl -s http://127.0.0.1:6421/health | jq '.status'
psql -p 6432 agenthive -c "SELECT COUNT(*) FROM roadmap_proposal.proposal;"
```

---

## See Also

- **P501 Runbook**: Phases 0–6 (schema install)
- **P502**: Logical replication (when shadow reads begin)
- **P503**: Read-shadow validation (48h consistency gate)
- **P505**: Cutover freeze (when env flip occurs)
- **P518**: Cutover execution (service restart + verification)
