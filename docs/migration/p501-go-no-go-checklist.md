# P501 Go/No-Go Decision Checklist

**Purpose**: Pre-flight validation that P501 hiveControl bootstrap is ready to execute  
**Execution**: Run 24 hours before P501 scheduled window  
**Authority**: Gate review (P501 proposal must reach REVIEW state for this checklist to be activated)  
**Approval**: Database Architect + Infrastructure Lead + two senior DBAs

---

## Pre-P501 Readiness (Operator performs 24h before)

### Infrastructure Readiness

- [ ] **Disk Space**: `/var/lib/postgresql` has ≥ 500 MB free
  ```bash
  df -h /var/lib/postgresql | tail -1 | awk '{print $4}'
  # Expected: ≥ 500M
  ```

- [ ] **PgBouncer Running**: Bouncer is accepting connections on port 6432
  ```bash
  psql -p 6432 -U postgres -d pgbouncer -c "SELECT version();"
  # Expected: psql connection succeeds, version output
  ```

- [ ] **PostgreSQL Running**: Primary instance is healthy on port 5432
  ```bash
  psql -d postgres -c "SELECT version();"
  # Expected: psql connection succeeds
  ```

- [ ] **No Scheduled Maintenance**: Verify no other DB work scheduled in the same 6-hour window
  ```bash
  # Check cron jobs, systemd timers, backup windows
  systemctl list-timers | grep -E "dump|backup|reindex"
  # Expected: No critical maintenance in window
  ```

- [ ] **Network Connectivity**: agenthive and hiveControl (Postgres backend) are reachable
  ```bash
  ping 127.0.0.1
  # Expected: Responses (local machine)
  ```

- [ ] **Backup Current agenthive**: Ensure tape backup is current (< 24h)
  ```bash
  ls -lh /backup/agenthive.sql.gz | tail -1
  # Expected: Timestamp within last 24h
  ```

---

### Database Health Checks

- [ ] **agenthive Is Healthy**: No table locks, no hung transactions
  ```bash
  psql -d agenthive -c \
    "SELECT COUNT(*) FROM pg_locks WHERE NOT granted;"
  # Expected: ≤ 5 locks (normal background ops)
  ```

- [ ] **agenthive Control Tables Are Readable**: Spot check key tables
  ```bash
  psql -d agenthive << 'SQL'
  SELECT COUNT(*) FROM roadmap_proposal.proposal;
  SELECT COUNT(*) FROM roadmap.project;
  SELECT COUNT(*) FROM roadmap.agent_registry;
  SQL
  # Expected: 319, 3, 7334 (or current values)
  ```

- [ ] **agenthive Schema Consistency**: No missing indexes or constraints
  ```bash
  # (Parity check result from latest simulation)
  # Expected: Zero fatal divergences
  ```

- [ ] **No Long-Running Transactions**: No queries running > 10 minutes
  ```bash
  psql -d agenthive -c \
    "SELECT pid, usename, state, query_start FROM pg_stat_activity 
     WHERE state='active' AND query_start < NOW() - INTERVAL '10 min';"
  # Expected: Empty result (no long queries)
  ```

- [ ] **Replication Slot Status** (if P502 is partial): No stale or stuck slots
  ```bash
  psql -d agenthive -c \
    "SELECT slot_name, active, restart_lsn FROM pg_replication_slots;"
  # Expected: Empty (pre-P502) or all active=true
  ```

---

### Service Readiness

- [ ] **All 6 Services Running**: agenthive-mcp, orchestrator, gate-pipeline, state-feed, a2a, copilot-agency
  ```bash
  systemctl status agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline \
    agenthive-state-feed agenthive-a2a agenthive-copilot-agency
  # Expected: 6 services active (running) or enabled
  ```

- [ ] **MCP Server Responding**: HTTP health check passes
  ```bash
  curl -s http://127.0.0.1:6421/health | jq '.status'
  # Expected: "ok" or success status
  ```

- [ ] **Database Pool Size Reasonable**: PgBouncer pool is not saturated
  ```bash
  psql -p 6432 -U postgres -d pgbouncer -c \
    "SHOW CLIENTS | grep -c agenthive"
  # Expected: < 30 active connections (pool_size=30)
  ```

- [ ] **No Pending Proposals in Critical State**: No proposals stuck in approval queues
  ```bash
  psql -d agenthive -c \
    "SELECT COUNT(*) FROM roadmap_proposal.proposal 
     WHERE state IN ('REVIEW', 'DEVELOP') AND locked_since < NOW() - INTERVAL '2 hours';"
  # Expected: 0 (no stale locks)
  ```

---

### Documentation Readiness

- [ ] **P501 Runbook Signed Off**: Two senior DBAs reviewed and approved
  ```bash
  # Check git log for recent approval commits to runbook
  git log --oneline docs/migration/p501-runbook.md | head -1
  # Expected: Recent commit with sign-off message
  ```

- [ ] **Risk Assessment Complete**: All top 5 risks identified and mitigated
  ```bash
  # Review docs/migration/p501-risk-assessment.md
  grep -c "RISK #" docs/migration/p501-risk-assessment.md
  # Expected: ≥ 5
  ```

- [ ] **Rollback Procedures Tested**: Each rollback scenario executed on clone
  ```bash
  # Review P504 rehearsal logs
  grep -i "rollback\|abort" /var/log/agenthive/p504-rehearsal.log
  # Expected: All rollback scenarios logged as "PASS"
  ```

- [ ] **Service Impact Matrix Complete**: Each service's readiness confirmed
  ```bash
  grep -c "Post-P501 Validation" docs/migration/p501-service-impact-matrix.md
  # Expected: ≥ 6 (one per service)
  ```

---

## Go/No-Go Decision Authority

### Decision Gate (Execute 2 hours before P501 window)

**Required Attendees**:
- Database Architect (decision authority)
- Infrastructure Lead (resource authority)
- Operator (execution readiness)
- Comms Lead (communication readiness)

**Voting Criteria**:

1. **GO Path** (Execute P501 immediately):
   - All infrastructure checks PASS
   - All database health checks PASS
   - All service health checks PASS
   - All documentation is signed off
   - Rollback procedures tested and verified
   - Escalation contact is on-call
   - Status page template approved

2. **NO-GO Path** (Abort, reschedule to next week):
   - Any infrastructure check FAILS
   - Any critical database health check FAILS (e.g., long-running transaction > 30 min)
   - Any service is down (except optional copilot-agency)
   - Runbook missing critical detail
   - Rollback procedure untested
   - Escalation contact unavailable

3. **CONDITIONAL GO** (Execute with mitigations):
   - One non-critical check fails (e.g., backup is 25 hours old instead of 24)
   - **Mitigation documented**: Operator acknowledges risk and commits to monitoring
   - Example: "Backup is 25h old; we will trigger manual backup immediately before P501"
   - Database Architect approves written mitigation

---

## Final Pre-Execution Checklist (T-15min before P501 window)

**Operator executes these final checks**:

- [ ] **Current Time**: Verify scheduled window is accurate
  ```bash
  date
  # Expected: Within 15 minutes of scheduled P501 start
  ```

- [ ] **Escalation Contact Acknowledged**: Named contact is on-call and reachable
  ```bash
  echo "Escalation contact: [Name], phone: [XXX-XXX-XXXX]"
  # Operator should have this written down
  ```

- [ ] **Comms Lead Ready**: Status page access verified, message template approved
  ```bash
  # Comms Lead confirms: "Ready to post to #incidents channel"
  ```

- [ ] **Backup Current State**: Take final agenthive backup before touching anything
  ```bash
  time pg_dump --schema-only agenthive > /tmp/agenthive-final-backup.sql && \
  echo "Backup size: $(du -h /tmp/agenthive-final-backup.sql | cut -f1)"
  # Expected: Completes in < 30s, file size ≥ 1 MB
  ```

- [ ] **PgBouncer Backup**: Save current pgbouncer.ini in case Phase 5 rollback needed
  ```bash
  cp /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/pgbouncer.ini.backup.p501
  ls -la /etc/pgbouncer/pgbouncer.ini.backup.p501
  ```

- [ ] **Clear /tmp Dump Space**: Ensure /tmp has room for schema dump
  ```bash
  rm -f /tmp/control_schema_dump.sql /tmp/*.dump
  df -h /tmp | tail -1 | awk '{print "Available: " $4}'
  # Expected: ≥ 500 MB
  ```

- [ ] **Test Database DSN (agenthive)**: Verify operator can connect
  ```bash
  psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/agenthive \
    -c "SELECT COUNT(*) FROM roadmap_proposal.proposal;"
  # Expected: 319 (or current count)
  ```

- [ ] **Services Are Stable**: No rapid restarts or errors
  ```bash
  journalctl -u agenthive-mcp -n 5 | tail -5
  # Expected: No ERROR lines from last 5 minutes
  ```

---

## Approval Sign-Off

**To be completed by Decision Gate attendees**:

### Database Architect Sign-Off

```
Name: [Signature]
Date: [YYYY-MM-DD HH:MM UTC]
Status: GO / NO-GO / CONDITIONAL GO
Conditions (if conditional): [List any mitigations]
Authority: Approved to proceed with P501 hiveControl bootstrap
```

### Infrastructure Lead Sign-Off

```
Name: [Signature]
Date: [YYYY-MM-DD HH:MM UTC]
Status: Infrastructure ready
Notes: Disk space verified, no other maintenance in window, PgBouncer healthy
```

### Operator Sign-Off

```
Name: [Signature]
Date: [YYYY-MM-DD HH:MM UTC]
Status: Ready to execute P501 runbook at T+0
Prepared: Yes, all tools ready, backup taken, rollback procedures tested
```

### Comms Lead Sign-Off

```
Name: [Signature]
Date: [YYYY-MM-DD HH:MM UTC]
Status: Ready to post status updates
Channels: #incidents (internal), status page (external)
Message template: Approved
```

---

## Execution Handoff

**Once all sign-offs complete**:

1. Operator reads aloud the first 5 steps of P501 Runbook (Phases 0–1)
2. Database Architect confirms: "Proceed with Phase 0 pre-flight checks"
3. Operator executes Phase 0; reports back: "All pre-flight checks passed"
4. Comms Lead posts to #incidents: "P501 deployment window OPEN, T+0 now"
5. Operator begins Phase 1

---

## Post-Execution Closure (After P501 completes)

**Within 1 hour of P501 completion**:

- [ ] **Operator Reports Success**: "P501 Phase 6 finalized; hiveControl bootstrap complete"

- [ ] **Comms Lead Updates Status Page**: "P501 deployment successful"

- [ ] **All Sign-Offs Document Actual Execution**: Log real wall-clock times, any deviations

- [ ] **P502 Readiness Gate Opens**: P502 (logical replication) can now be scheduled

---

## Contingency Thresholds

**If any of these occur during P501, Operator MUST escalate immediately**:

| Condition | Action | Escalation |
|-----------|--------|-------------|
| Phase 2 (dump) hangs > 60s | Kill dump process | Escalation Contact → ABORT |
| Phase 2 (restore) produces ERROR | Roll back (Rollback-A) | Escalation Contact → reschedule |
| Parity check fails (fatal) | Investigate divergence | Database Architect → reschedule |
| Sequence count < 101 | Halt P504 prep | Database Architect → investigate |
| PgBouncer RELOAD fails | Restore ini + rollback | Infra Ops + Escalation Contact |
| Disk space drops < 100MB | Pause, free space | Infra Ops |
| Any service crashes | Check logs, assess impact | Operator + Escalation Contact |

---

## See Also

- **P501 Runbook**: Phases 0–6 (forward execution path)
- **P501 Risk Assessment**: Top 5 risks + mitigations
- **P501 Rollback**: Procedures for each phase
- **P501 Service Impact**: Health checks per service
- **P504 Rehearsal**: Dry-run results (should be reviewed as input to this checklist)

---

## Archive & Audit Trail

**After P501 completes, store**:
- This checklist (signed)
- P501 runbook execution log (timestamps + output)
- P504 rehearsal report (reference)
- Any escalations or deviations (root cause + resolution)

**Location**: `/var/log/agenthive/p501-execution-<date>.log`

**Retention**: 1 year (compliance; post-migration audit trail)
