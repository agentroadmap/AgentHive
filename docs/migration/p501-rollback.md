# P501 Rollback Procedures

**Scope**: How to safely abort or rollback P501 at each phase without data loss or service interruption

**Key Guarantee**: agenthive remains untouched throughout P501; rollback always preserves live data

---

## Immediate Rollback (Phases 0–3)

If any phase fails before the PgBouncer reload (Phase 5), execute:

### Rollback-A: Drop hiveControl Database (SAFE)

```bash
# Step 1: Terminate any connections to hiveControl (should be none at this stage)
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres << 'SQL'
SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE datname='hiveControl' AND pid <> pg_backend_pid();
SQL
```

### Step 2: Drop the database
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres << 'SQL'
DROP DATABASE IF EXISTS hiveControl;
SQL
```

### Step 3: Verify hiveControl is gone
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c \
  "SELECT COUNT(*) FROM pg_database WHERE datname='hiveControl';"
```
**Expected**: 0

### Step 4: Verify services still connect to agenthive
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/agenthive -c \
  "SELECT COUNT(*) FROM roadmap_proposal.proposal;"
```
**Expected**: 319 (unchanged)

### Step 5: agenthive is live again
No service restarts required; they continue on agenthive via PgBouncer and env config pointing to agenthive DSN.

**Time to restore**: < 1 minute  
**Data loss**: Zero  
**Service interruption**: Zero

---

## Conditional Rollback (Phase 4: Parity Check Failures)

If Phase 4 parity check fails with FATAL divergence:

### Rollback-B: Schema Remediation or Retry

#### If fatal divergence is a known exception (e.g., expected function body md5 mismatch due to pre-deployment schema changes):

1. **Document the exception**:
   ```
   Exception: roadmap_proposal.frontier_audit_log trigger function body differs
   Reason: P498 pre-deployment altered the trigger definition in agenthive only
   Decision: Accept divergence; services do not rely on this trigger
   ```

2. **Re-run parity check with --ignore-exceptions**:
   ```bash
   node scripts/deploy/parity-check.ts --ignore-exceptions='frontier_audit_log.function_body'
   ```

3. **Re-validate Phase 5 (PgBouncer) can proceed**

#### If fatal divergence is unknown:

1. **Halt P501 immediately**

2. **Rollback-A (drop hiveControl)**

3. **Investigate schema divergence**:
   ```bash
   # What changed between agenthive and hiveControl in this one table?
   psql -d agenthive -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='roadmap_proposal' AND table_name='frontier_audit_log' ORDER BY ordinal_position;" > /tmp/agenthive_cols.txt
   
   psql -d hiveControl -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='roadmap_proposal' AND table_name='frontier_audit_log' ORDER BY ordinal_position;" > /tmp/hivecontrol_cols.txt
   
   diff /tmp/agenthive_cols.txt /tmp/hivecontrol_cols.txt
   ```

4. **Root cause**:
   - Did the dump fail mid-table?
   - Did the restore fail silently for this table?
   - Is there a DDL issue in agenthive itself?

5. **Remediate**:
   - If dump issue: re-run Phase 2.1–2.4
   - If restore issue: re-run Phase 2.3 (restore) for affected table
   - If source issue: fix agenthive schema first, then re-run P501

6. **Re-run full P501 cycle** (no shortcut patching; parity check must pass cleanly)

---

## Conditional Rollback (Phase 5: PgBouncer Reload Failure)

If Phase 5 PgBouncer reload fails:

### Rollback-C: Restore PgBouncer Configuration

#### Step 1: Identify pgbouncer.ini state
```bash
grep -n hiveControl /etc/pgbouncer/pgbouncer.ini
```

#### Step 2: If hiveControl config is malformed, remove it
```bash
# Edit pgbouncer.ini and remove the hiveControl entry, OR
# Restore from backup
cp /etc/pgbouncer/pgbouncer.ini.backup /etc/pgbouncer/pgbouncer.ini
```

#### Step 3: Reload PgBouncer
```bash
psql -p 6432 -U postgres -d pgbouncer -c "RELOAD;"
```
**Expected**: No error.

#### Step 4: Verify agenthive connections still work
```bash
psql -p 6432 -U agenthive_admin -d agenthive -c "SELECT COUNT(*) FROM roadmap_proposal.proposal;"
```
**Expected**: 319

#### Step 5: Rollback hiveControl (if it exists)
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c "DROP DATABASE IF EXISTS hiveControl;"
```

**Time to restore**: < 1 minute  
**Data loss**: Zero  
**Service interruption**: Possible brief connections drop during RELOAD (< 5s)

---

## Rollback After Phase 5 Success (Pre-P502)

If P501 succeeds (hiveControl created, PgBouncer reloaded) but P502 encounters issues before logical replication starts:

### Rollback-D: Full Revert to agenthive

#### Step 1: Verify hiveControl is empty (no data, schema-only)
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl -c \
  "SELECT COUNT(*) as row_count FROM (
    SELECT 1 FROM roadmap_proposal.proposal
    UNION ALL
    SELECT 1 FROM roadmap.agent_registry
    UNION ALL
    SELECT 1 FROM roadmap.project
  ) t;"
```
**Expected**: 0 (no data rows in hiveControl)

#### Step 2: Remove hiveControl from pgbouncer.ini
```bash
# Option A: Edit manually and remove hiveControl lines
sudo nano /etc/pgbouncer/pgbouncer.ini
# Find [databases] section, remove: hiveControl = ...

# Option B: Restore from backup
cp /etc/pgbouncer/pgbouncer.ini.backup /etc/pgbouncer/pgbouncer.ini
```

#### Step 3: Reload PgBouncer
```bash
psql -p 6432 -U postgres -d pgbouncer -c "RELOAD;"
```

#### Step 4: Drop hiveControl
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c "DROP DATABASE IF EXISTS hiveControl;"
```

#### Step 5: Verify agenthive is live
```bash
psql -p 6432 -U agenthive_admin -d agenthive -c "SELECT COUNT(*) FROM roadmap_proposal.proposal;"
```
**Expected**: 319

#### Step 6: No service restarts needed
Services remain on agenthive env config; PgBouncer re-routes to agenthive pool.

**Time to restore**: < 2 minutes  
**Data loss**: Zero  
**Service interruption**: None (transparent pool switching)

---

## Rollback After P502 Begins (Replication Active)

If P502 starts logical replication and issues arise, rollback is **slightly more complex** because agenthive and hiveControl may diverge:

### Rollback-E: Stop Replication, Revert to agenthive

#### Step 1: Stop logical replication subscription on hiveControl
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl << 'SQL'
ALTER SUBSCRIPTION agenthive_repl_sub DISABLE;
SQL
```

#### Step 2: Verify subscription is disabled
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/hiveControl -c \
  "SELECT subname, subenabled FROM pg_subscription;"
```
**Expected**: agenthive_repl_sub with subenabled=false

#### Step 3: Remove hiveControl from pgbouncer.ini
(Same as Rollback-D Step 2)

#### Step 4: Reload PgBouncer
(Same as Rollback-D Step 3)

#### Step 5: Verify agenthive is still live (should be untouched)
```bash
psql -p 6432 -U agenthive_admin -d agenthive -c \
  "SELECT COUNT(*) FROM roadmap_proposal.proposal;"
```
**Expected**: 319 + any writes that occurred during replication window

#### Step 6: Optionally drop hiveControl
```bash
psql -d postgresql://admin:${ADMIN_PASSWORD}@127.0.0.1:5432/postgres -c "DROP DATABASE IF EXISTS hiveControl;"
```

**Time to restore**: < 2 minutes  
**Data loss**: Zero (all writes stay on agenthive, which remains canonical)  
**Service interruption**: None

---

## Rollback During Cutover (P505 Active)

If P505 cutover is in progress and must abort mid-operation:

### Rollback-F: Immediate Env Flip Back to agenthive

**This is a RED ALERT scenario handled by the Escalation Contact.**

#### Step 1 (Operator action): Flip env var immediately
```bash
# Edit /etc/agenthive/env
AGENTHIVE_DATABASE_URL=postgresql://agenthive_admin:${PASS}@127.0.0.1:5432/agenthive

# Restart services (systemd units)
sudo systemctl restart agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline agenthive-state-feed agenthive-a2a agenthive-copilot-agency
```

#### Step 2 (Comms Lead): Post to #incidents
```
CUTOVER ABORT at T+XX min. Reverting to agenthive. Services restarting. ETA 2 minutes back online.
```

#### Step 3 (DB-Deploy Witness): Verify agenthive is accepting writes
```bash
psql -p 6432 -U agenthive_admin -d agenthive -c \
  "UPDATE roadmap.proposal SET modified_at = NOW() WHERE id=505 RETURNING id, modified_at;"
```
**Expected**: Successful UPDATE (latency < 100ms)

#### Step 4 (Escalation Contact): Declare abort reason
```
Root cause analysis: [sequence mismatch | replication lag spike | MCP health check failed]
Operator: [action taken]
Next review: [time] with all reviewers
```

**Time to restore**: 1–2 minutes  
**Data loss**: Zero (writes during P505 were to agenthive only until cutover completed)  
**Service interruption**: 1–2 minutes (service restart + reconnection)

---

## Post-Cutover Fallback (P505 Completed, P506 Window)

After cutover succeeds and hiveControl is live, there is a 7-day "fallback window" (P506 sunset) where agenthive's control schemas remain in place:

### Rollback-G: Fallback to agenthive if hiveControl Fails

**This is a LAST-RESORT scenario in case hiveControl suffers catastrophic failure (corruption, hardware failure).**

#### Precondition:
- hiveControl is live (services on hiveControl for days 0–7)
- Logical replication is still active, mirroring writes from hiveControl back to agenthive
- agenthive.roadmap_proposal.* contain all data written to hiveControl

#### Step 1 (Escalation Contact decision): If hiveControl is unrecoverable
```
Decision: FALLBACK to agenthive
Reason: hiveControl corruption/failure; agenthive is 100% up-to-date via logical replication
Action: Flip env back to agenthive; restart services
```

#### Step 2 (Operator): Flip env to agenthive
```bash
# Edit /etc/agenthive/env
AGENTHIVE_DATABASE_URL=postgresql://agenthive_admin:${PASS}@127.0.0.1:5432/agenthive

sudo systemctl restart agenthive-mcp agenthive-orchestrator agenthive-gate-pipeline agenthive-state-feed agenthive-a2a agenthive-copilot-agency
```

#### Step 3 (DB-Deploy Witness): Verify agenthive is live
```bash
psql -p 6432 -U agenthive_admin -d agenthive -c \
  "SELECT COUNT(*) FROM roadmap_proposal.proposal;"
```
**Expected**: Count ≥ 319 (includes any cutover-window writes)

#### Step 4 (Escalation Contact): Investigate hiveControl failure
- Was this a replication lag issue (could be temporary)?
- Was this a disk/hardware failure?
- Is hiveControl recoverable?

#### Step 5 (DB-Deploy): Once hiveControl is fixed
- Re-bootstrap hiveControl from backup
- Re-run logical replication setup
- Prepare for a re-cutover (P518-v2)

**Time to restore**: 1–2 minutes  
**Data loss**: Zero (agenthive replicated all hiveControl writes)  
**Service interruption**: 1–2 minutes (service restart)

---

## Rollback Impact Summary Table

| Phase | Rollback Procedure | Time to Restore | Data Loss | Service Interruption |
|-------|-------------------|-----------------|-----------|----------------------|
| 0–4 (Pre-PgBouncer) | Rollback-A (DROP hiveControl) | < 1 min | ZERO | ZERO |
| 5 (PgBouncer Reload) | Rollback-C (restore ini) | < 1 min | ZERO | < 5s (reload) |
| Post-5 (Pre-replication) | Rollback-D (full revert) | < 2 min | ZERO | ZERO |
| 502+ (Replication Active) | Rollback-E (disable sub) | < 2 min | ZERO | ZERO |
| 505 (Cutover Active) | Rollback-F (env flip) | 1–2 min | ZERO | 1–2 min |
| 506+ (Post-Cutover, 7d window) | Rollback-G (fallback) | 1–2 min | ZERO | 1–2 min |

---

## Testing Rollback Procedures

**Before Production P501:**

1. **P504 Rehearsal**: Test each rollback procedure on the clone cluster
2. **Dry-run PgBouncer reload** on clone: verify RELOAD syntax and timing
3. **Dry-run env flip**: restart services, verify reconnection
4. **Document time**: measure actual wall-clock time for each procedure

**Expected**: All rollbacks complete in < 2 minutes; zero data loss; service comes back live.

---

## Key Assumptions & Caveats

1. **Logical replication slot**: If P502 creates a replication slot and P501 is rolled back before slot is cleaned up, the slot persists. P501 re-run will need to clean up the old slot first (DROP SUBSCRIPTION, then DROP SLOT).

2. **PgBouncer state**: After any rollback, PgBouncer pools are already disconnected. New connections via env flip will create new pools automatically.

3. **Sequence state**: If P501 completes but rollback occurs, sequence values in hiveControl may have drifted from agenthive (sequences are not replicated until P502). This is acceptable because hiveControl is deleted.

4. **In-flight transactions**: If a service had an open transaction to hiveControl and we rollback the env, that transaction is lost. Mitigation: services use connection pooling (30s timeout) and short transactions, so impact is minimal.

---

## See Also

- **P501 Runbook**: Phases 0–6 (forward path)
- **P502**: Logical replication setup (adds risk of split-brain)
- **P505**: Cutover execution (point of no return; P506 fallback window mitigates)
- **P506**: Post-cutover cleanup (marks end of fallback window)

---

## Emergency Contacts

**If rollback is needed:**
1. **Operator** (executing rollback): [Name, Phone]
2. **Escalation Contact** (authorization): [VP Eng, Phone]
3. **Comms Lead** (status page): [Name, Slack]
4. **DB-Deploy Witness** (validation): [Name, Phone]

**Escalation path**:
- Operator detects issue → Escalation Contact → Comms Lead → Status page post
