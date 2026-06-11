# P1447: A2A Host Cutover Playbook

**Status:** P1447 DEVELOP (code delivery)  
**Operator Action Required:** Post-merge cutover execution  
**Related:** P1132 (A2A Host Service), P1437 (presence probe), P1138 (PG reconnect)

## Overview

This document guides the cutover from per-agency `agenthive-agency@*` and `agenthive-liaison@*` systemd template units to the centralized `agenthive-a2a-host.service` runtime. The a2a-host service is COMPLETE but INERT — it must be integrated into the live operational flow with zero downtime.

### Current State (2026-06-10)

- **Code delivered:** P1132 merged (2026-05-18), a2a-host fully functional
- **Code not yet deployed:** initConfig() fix (P1447) + backfill script (P1447)
- **Operational state:** agenthive-a2a-host.service running but EXCLUDES all agencies (agency-filter inverted or AGENTHIVE_HOST mismatch)
- **Live agencies:** All 18+ still served by legacy per-agency units (no downtime, cutover blocked)
- **Risk:** P1132's gate verified CODE shipped, not that cutover happened → follow-up P1447 required

## Pre-Cutover Checklist

### Phase 0: Code Merge (Operator runs after P1447 code merged to main)

1. Code changes merged to `main`:
   - ✓ initConfig() added to start-a2a-host.ts (AC-2 enablement)
   - ✓ Migration 187 backfills missing agent_registry rows
   - ✓ Verification script created at scripts/verify-a2a-host-cutover.ts

2. Ensure migrations are applied:
   ```bash
   # On bot, verify migration 187 has run:
   psql "$DATABASE_URL" -c "SELECT * FROM core.migrations WHERE number = 187"
   # If not applied yet, apply via ./hive db apply 187
   ```

### Phase 1: Pre-Cutover Verification (Per-host, starting with `bot`)

**Target host:** `bot` (where all 18+ agencies currently live)

1. **Populate AGENTHIVE_HOST environment variable:**

   ```bash
   # Method A: /etc/agenthive/env (permanent, affects all services on host)
   echo "AGENTHIVE_HOST=bot" | sudo tee /etc/agenthive/env
   
   # Verify it's set:
   source /etc/agenthive/env && echo $AGENTHIVE_HOST
   # Output: bot
   ```

   **Alternative (testing only):** Export before restart:
   ```bash
   export AGENTHIVE_HOST=bot
   sudo systemctl restart agenthive-a2a-host.service
   ```

2. **Restart a2a-host with initConfig() fix:**

   ```bash
   sudo systemctl restart agenthive-a2a-host.service
   
   # Monitor the boot:
   sudo journalctl -u agenthive-a2a-host.service -f --since "30 seconds ago"
   
   # Expected output (within 10-15 seconds):
   # - "[a2a-host] starting on host=bot"
   # - "[a2a-host] flags: { listenRefreshMs: 60000, ... }"
   # - "[a2a-host] booting 18 agencies: claude-bot-gary.a, codex-bot-andy.a, ..."
   # - "[a2a-host] boot complete — 18 of 18 agencies online"
   ```

3. **Run verification script:**

   ```bash
   npx tsx scripts/verify-a2a-host-cutover.ts --target bot
   
   # Expected output:
   #   ✓ All roadmap.agency rows have agent_registry matches
   #   ✓ A2A host listeners attached for all local agencies (18/18)
   #   ✓ Recent fn_pulse heartbeats detected (18 agencies)
   #   ✓ No stale presence_state (all online agencies have matching state)
   #   Exit code: 0
   ```

4. **Confirm side-by-side operation (dual LISTEN sessions):**

   ```bash
   # Should show BOTH legacy units + a2a-host listeners active:
   psql "$DATABASE_URL" -c "
     SELECT
       COUNT(CASE WHEN application_name LIKE 'agenthive-agency@%' THEN 1 END) as legacy_units,
       COUNT(CASE WHEN application_name LIKE 'agenthive-a2a-listen-%' THEN 1 END) as a2a_listeners,
       COUNT(DISTINCT application_name) as total_sessions
     FROM pg_stat_activity
   "
   
   # Expected: legacy_units=18, a2a_listeners=18, total_sessions=36+
   ```

5. **Confirm all agencies show online + fresh heartbeat:**

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT
       presence_state,
       COUNT(*) as count,
       MAX(last_heartbeat_at) as newest_heartbeat
     FROM roadmap_workforce.agent_registry
     WHERE agent_type IN ('agency','llm') AND status IN ('active','dormant')
     GROUP BY presence_state
     ORDER BY presence_state
   "
   
   # Expected: presence_state='online' for all 18 agencies, heartbeat < 60 seconds old
   ```

6. **Run end-to-end dispatch test** (optional, builds confidence):

   ```bash
   # Dispatch a small work offer to one agency, confirm it's claimed:
   psql "$DATABASE_URL" -c "
     INSERT INTO roadmap_workforce.work_offers
       (proposal_id, agency_id, offer_expires_at, status, dispatch_route)
     VALUES (1, 'claude-bot-gary.a', now() + interval '30 seconds', 'available', 'test')
     RETURNING id
   "
   # Then monitor claim within 10 seconds:
   psql "$DATABASE_URL" -c "
     SELECT status, claimed_by_agency, claimed_at
     FROM roadmap_workforce.work_offers
     WHERE id = <ID from above>
   "
   # Expected: status='claimed', claimed_by_agency='claude-bot-gary.a', claimed_at within 30s
   ```

### Phase 2: Retirement of Per-Agency Units

**CRITICAL:** Only proceed if Phase 1 verification passed with a2a-host holding 100% coverage.

1. **Disable per-agency template units:**

   ```bash
   # Disable the template (prevents new instances from auto-starting):
   sudo systemctl disable agenthive-agency@.service agenthive-liaison@.service
   
   # Stop all active instances:
   sudo systemctl stop 'agenthive-agency@*' 'agenthive-liaison@*'
   
   # Verify they're stopped:
   sudo systemctl list-units 'agenthive-agency@*.service' 'agenthive-liaison@*.service' --state=running --no-pager
   # Expected output: "0 loaded units listed"
   ```

2. **Confirm a2a-host still holds all LISTEN sessions:**

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT COUNT(*) as a2a_listeners
     FROM pg_stat_activity
     WHERE application_name LIKE 'agenthive-a2a-listen-%'
   "
   # Expected: 18 (or however many agencies are on bot)
   ```

3. **Verify agencies remain online:**

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT
       presence_state,
       COUNT(*) as count,
       MAX(last_heartbeat_at) as newest_heartbeat
     FROM roadmap_workforce.agent_registry
     WHERE agent_type IN ('agency','llm') AND status IN ('active','dormant')
     GROUP BY presence_state
   "
   # Expected: presence_state='online', heartbeat < 60 seconds old
   ```

4. **Remove the template unit files** (once confident cutover is stable):

   ```bash
   # After 1 hour of successful a2a-host-only operation:
   sudo rm -f /etc/systemd/system/agenthive-agency@.service \
              /etc/systemd/system/agenthive-liaison@.service \
              /etc/systemd/system/agenthive-liaison-bot.service \
              /etc/systemd/system/agenthive-agency-*
   
   sudo systemctl daemon-reload
   
   # Verify removal:
   systemctl list-units 'agenthive-agency@*.service' --state=any --no-pager
   # Expected: "0 loaded units listed" (nothing left)
   ```

### Phase 3: Per-Host Rollout

Repeat Phases 1-2 for remaining hosts in order:

1. **bot** (primary, completed first)
2. **imac** (secondary, if any agencies assigned)
3. **Hermes** (if any agencies assigned)
4. **mini** (if any agencies assigned)
5. **gmktec** (if any agencies assigned)

For each host:
- Set `AGENTHIVE_HOST` in /etc/agenthive/env
- Restart a2a-host
- Run verification script
- Confirm side-by-side operation (min 1 hour)
- Retire per-agency units
- Remove template files

## Rollback Procedure

**If a2a-host fails after per-agency units are retired:**

### Immediate Recovery (Restore Service < 30 seconds)

1. **Re-enable and restart per-agency template units:**

   ```bash
   # Restore template unit files (they should be in git or backed up):
   sudo git checkout /etc/systemd/system/agenthive-agency@.service \
                     /etc/systemd/system/agenthive-liaison@.service
   
   sudo systemctl daemon-reload
   sudo systemctl enable agenthive-agency@.service agenthive-liaison@.service
   
   # Start instances for all agencies on this host:
   # (the systemctl enable sets up the target dependencies, or manually:)
   for AGENCY in claude-bot-gary.a codex-bot-andy.a ...; do
     sudo systemctl start agenthive-agency@${AGENCY}.service
   done
   ```

2. **Verify recovery:**

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT application_name, count(*) FROM pg_stat_activity
     WHERE application_name LIKE 'agenthive-agency@%' OR application_name LIKE 'agenthive-liaison@%'
     GROUP BY application_name
   "
   # Agencies should re-online within 30-60 seconds
   ```

### Root Cause Investigation

1. **Check a2a-host journal for error:**

   ```bash
   sudo journalctl -u agenthive-a2a-host.service -n 50 --no-pager
   ```

   Common causes:
   - `FATAL pool error` → PG connectivity issue (check PG status)
   - `bootLiaison failed: not registered` → agency_registry row missing (run AC-9 fix)
   - `LISTEN client error on <agency>` → PG connection instability (see P1142 chaos test)

2. **File incident:**
   - Outcome: per-agency units restored manually; a2a-host needs investigation
   - Action: Create P-ticket for root cause + retest on non-critical host first

## Documentation Updates (AC-8)

### Updated Files

1. **CONVENTIONS.md** (already updated 2026-05-31, P1132):
   - Section 3.0 (Service Topology): a2a-host is canonical runtime
   - Legacy template units marked deprecated

2. **service-topology-runbook.md** (P1361 section):
   ```markdown
   ### DEPRECATED: Per-Agency Template Units
   
   The agenthive-agency@* and agenthive-liaison@* template units are retired
   as of P1447 (2026-06-XX) in favor of the centralized agenthive-a2a-host.service.
   
   This section is retained for historical reference only.
   ```

3. **a2a-host.md** (docs/operations/troubleshooting/):
   - Canonical reference for operational troubleshooting
   - Links to this cutover playbook

## Acceptance Criteria Mapping

| AC  | Title                            | Delivery Status          | Verification               |
|-----|----------------------------------|--------------------------|----------------------------|
| AC-1 | Host discovery fixed              | CODE: start-a2a-host.ts | Verify journal "boot complete — 18 of 18 agencies online" |
| AC-2 | Identity reconciliation           | CODE: initConfig() fix   | Verify runtime_flag reads don't fail |
| AC-3 | Authoritative presence writer    | CODE: fn_pulse lines 333,341 | Run verification script; confirm presence_state='online' |
| AC-4 | Coverage parity before retirement | OPERATIONAL: Phase 1 step 4 | Verify side-by-side LISTEN sessions (legacy + a2a) |
| AC-5 | Legacy units retired              | OPERATIONAL: Phase 2 step 1 | `systemctl stop 'agenthive-agency@*'` |
| AC-6 | No double-run regression          | OPERATIONAL: Phase 1 step 4 | Confirm 18+18 sessions, not 18+0 |
| AC-7 | AGENTHIVE_HOST set per host       | OPERATIONAL: Phase 1 step 1 | Verify /etc/agenthive/env populated |
| AC-8 | Docs reconciled                   | CODE: docs/ updates above | Manual review |
| AC-9 | All agencies have agent_registry  | MIGRATION 187 (backfill) | Run verification script |
| AC-10| 11 agencies explicitly handled   | N/A (clarified in design) | Only agencies with valid host_affinity + provider are booted |
| AC-11| Presence ownership formalized     | CODE + DOCS: this file | Review grep 'fn_pulse' in start-a2a-host.ts |
| AC-12| NOTIFY reachability verified      | DEPENDENCY: P1432 (orchestrator pinning) | Deferred to orchestrator work offer fix |
| AC-13| Cutover sequence documented      | CODE: this playbook | Follow phases 1-2 in order |
| AC-14| Host topology registry            | SCHEMA: roadmap.host_model_policy | Manual operator setup |
| AC-15| Backfill script exists            | CODE: scripts/verify-a2a-host-cutover.ts | Run with --fix flag |
| AC-16| Post-cutover verification (1 hour) | OPERATIONAL: Phase 2 step 3 | Monitor presence_state continuously |
| AC-17| Rollback gate documented          | CODE: "Rollback Procedure" section | Use as reference for emergency restore |
| AC-18| Canonical reconciliation          | MIGRATION 187 + CODE | Verification script checks |

## Support & Escalation

- **Questions:** File P-ticket tagged `cutover`
- **Failures during verification:** Do NOT proceed to retirement; investigate and file blocker
- **Emergency rollback needed:** Execute "Immediate Recovery" section above; file incident
- **Multi-host coordination:** Operator handles sequencing to avoid simultaneous failures

---

**Last updated:** 2026-06-10 (P1447)  
**Canonical docs:** `CONVENTIONS.md` §3, `a2a-host.md` troubleshooting scenarios
