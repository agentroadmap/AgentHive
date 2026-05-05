# hiveCentral DR Drill Runbook

**Proposal:** P591. **Parent doc:** `docs/dr/hivecentral-dr-design.md`.
**Script:** `scripts/dr/hivecentral-failover.sh`.
**Last revised:** 2026-04-27.

This runbook governs all scheduled DR drills. It is the reviewable artifact for AC14 (two-person ops review).

---

## 0. Drill types and cadence

| Type | Cadence | AC | kind logged |
|---|---|---|---|
| **Clean failover drill** | Monthly | AC3–AC6 | `dr_drill` |
| **Stuck-claim drill** | Quarterly (one of the monthly slots) | AC7 | `dr_drill` |
| **Backup-restore drill** | Quarterly | AC13 | `backup_restore_drill` |
| **Cold DR drill** | Annually | — | `cold_dr_drill` |

One quarterly drill **must be after-hours** with the backup on-call executing (primary deliberately does not ack — exercises the escalation path). See design §5e.

---

## 1. Staging environment prerequisites

These must be verified before any drill. If any item is missing, the drill is blocked until it is resolved.

### 1.1 Hosts and services

| Requirement | How to verify |
|---|---|
| `stg-A1` (staging primary) running PostgreSQL 16 | `ssh stg-A1 systemctl is-active postgresql@16-main` → `active` |
| `stg-A2` (staging standby) in streaming recovery | `ssh stg-A2 sudo -u postgres psql -tAc 'SELECT pg_is_in_recovery()'` → `t` |
| Streaming replication lag ≤ 30 s | `ssh stg-A2 sudo -u postgres psql -tAc "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))"` → ≤ 30 |
| PgBouncer running and pointed at `stg-A1` | `psql -h stg-pgbouncer -p 6432 -d hiveCentral -c 'SELECT 1'` succeeds; `grep host= /etc/pgbouncer/pgbouncer.ini` shows `stg-A1` |
| `agenthive-orchestrator` (staging instance) running | `ssh stg-A1 systemctl is-active agenthive-orchestrator` → `active` |
| `agenthive-copilot-agency` (staging) running | `ssh stg-A1 systemctl is-active agenthive-copilot-agency` → `active` |
| At least one active proposal lease in staging | `psql -h stg-pgbouncer -d hiveCentral -c "SELECT COUNT(*) FROM roadmap.v_agency_status WHERE status='active'"` → ≥ 1 |
| DR scripts deployed to staging DR_DIR | `ls /usr/local/share/agenthive/dr/` on `stg-A1` shows `lease-reconcile.sql`, `post-failover-verify.sql`, `record-dr-event.sql` |
| Clock sync ≤ 5 s on both staging hosts | `chronyc tracking` on `stg-A1` and `stg-A2`; check `Last offset` |

### 1.2 Required env vars (export before running)

```bash
export AGENTHIVE_PRIMARY_HOST=stg-A1
export AGENTHIVE_STANDBY_HOST=stg-A2
export AGENTHIVE_PGBOUNCER_CONFIG=/etc/pgbouncer/pgbouncer.ini   # on stg-A1
export AGENTHIVE_DR_ARTIFACTS_DIR=/usr/local/share/agenthive/dr
```

### 1.3 Measurement setup

Before starting the drill clock, note:

```bash
T_DRILL_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

RPO is measured as the difference between the last WAL LSN applied on `stg-A2` at the moment of promotion and the last LSN committed on `stg-A1` just before shutdown. The failover script logs `Standby replay lag (bytes behind receive)` — **this is the RPO proxy**; ≤ 16 MB is within the 60 s window under normal load.

RTO is measured from `T_DRILL_START` to the first successful query via PgBouncer after `systemctl reload pgbouncer`. The script timestamps each step; check `LOG` for step-level timing.

---

## 2. Clean failover drill (AC3–AC6)

**Objective:** Verify end-to-end failover completes within RPO ≤ 60 s and RTO ≤ 5 min, and that no orphan leases are created when no agents are mid-flight at the kill moment.

### 2.1 Pre-drill state check

```bash
# Count active leases before drill — must be 0 for clean drill (no mid-flight agents)
psql -h stg-pgbouncer -p 6432 -U admin -d hiveCentral \
  -c "SELECT COUNT(*) AS active_leases FROM proposal.proposal_lease WHERE status='active';"
# Expected: 0
```

If active_leases > 0, wait for agents to finish or reschedule the drill for a quiet window.

### 2.2 Note the current replication LSN (RPO baseline)

```bash
# On stg-A1 (primary):
T_DRILL_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PRIMARY_LSN="$(ssh stg-A1 sudo -u postgres psql -tAc "SELECT pg_current_wal_lsn();")"
echo "T_DRILL_START=$T_DRILL_START  PRIMARY_LSN=$PRIMARY_LSN"
```

### 2.3 Simulate primary failure

```bash
# Hard-stop PG primary (simulates host crash without clean shutdown)
ssh stg-A1 sudo systemctl stop postgresql@16-main
```

### 2.4 Run failover script

```bash
export AGENTHIVE_PRIMARY_HOST=stg-A1
export AGENTHIVE_STANDBY_HOST=stg-A2
export AGENTHIVE_PGBOUNCER_CONFIG=/etc/pgbouncer/pgbouncer.ini
export AGENTHIVE_DR_ARTIFACTS_DIR=/usr/local/share/agenthive/dr

bash scripts/dr/hivecentral-failover.sh
```

Monitor the log (`/var/log/agenthive/dr-failover-*.log`) in a second terminal.

### 2.5 Measure RPO and RTO

```bash
T_PGBOUNCER_FLIP="$(grep 'PgBouncer reloaded' /var/log/agenthive/dr-failover-*.log | tail -1 | cut -d']' -f1 | tr -d '[' )"

# RPO: bytes of WAL not replicated at the time of promotion.
# From failover log line "Standby replay lag (bytes behind receive): N"
REPLAY_LAG_BYTES=$(grep 'Standby replay lag' /var/log/agenthive/dr-failover-*.log | tail -1 | awk '{print $NF}')

# RTO: wall clock from T_DRILL_START to first successful query post-flip
T_POST_FLIP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "RPO proxy (WAL bytes unsynced): $REPLAY_LAG_BYTES  (≤ ~60s worth = acceptable)"
echo "RTO: $(python3 -c "from datetime import datetime; print((datetime.fromisoformat('${T_POST_FLIP//Z/}') - datetime.fromisoformat('${T_DRILL_START//Z/}')).seconds, 's')")"
```

**AC4 pass criterion:** replay lag bytes correspond to ≤ 60 s of WAL (under typical load: < 16 MB).
**AC5 pass criterion:** total elapsed seconds ≤ 300.

### 2.6 Verify no orphans (AC6)

```bash
psql -h stg-A2 -p 5432 -U admin -d hiveCentral \
  -c "SELECT COUNT(*) FROM roadmap.dr_orphan_lease_request WHERE request_status='pending';"
# Expected: 0 (no active leases existed, so nothing to orphan)
```

### 2.7 Record result

```bash
psql -U admin -h stg-A2 -p 5432 -d hiveCentral \
  -v event_kind='dr_drill' \
  -v operator='YOUR_NAME' \
  -v rpo_seconds='<measured RPO seconds or 0>' \
  -v rto_seconds='<measured RTO seconds>' \
  -v decision_seconds='<operator decision latency seconds>' \
  -v clock_skew_max='<max clock offset observed>' \
  -v notes='"clean failover drill; no active leases"' \
  -f /usr/local/share/agenthive/dr/record-dr-event.sql
```

Confirm a row exists:
```sql
SELECT entry_id, entry_kind, payload FROM governance.decision_log
  WHERE entry_kind = 'dr_drill' ORDER BY entry_id DESC LIMIT 1;
```

### 2.8 Restore staging to baseline

```bash
# Restart PG on stg-A1 (will start as standby — requires recovery.conf or pg_basebackup)
# Standard practice: pg_basebackup -h stg-A2 -R -D /var/lib/postgresql/16/main
# Then restore PgBouncer config to point back at stg-A1
sed -i "s/host=stg-A2/host=stg-A1/" /etc/pgbouncer/pgbouncer.ini
systemctl reload pgbouncer
```

---

## 3. Stuck-claim drill (AC7)

**Objective:** Verify that an agent holding an active lease at the moment of failover has its lease released as an orphan by the reconciliation pass.

### 3.1 Create a synthetic stuck agent

```bash
# In staging, claim a lease on a test proposal from a shell session
# (this simulates a mid-flight agent that will be killed)
LEASE_ID=$(psql -h stg-pgbouncer -p 6432 -U admin -d hiveCentral -tAc "
  INSERT INTO proposal.proposal_lease
    (proposal_id, agent_identity, claimed_at, last_renewed_at, status, lease_duration_seconds)
  VALUES
    (1, 'did:hive:spawn:stg-stuck-test:1', now(), now(), 'active', 300)
  RETURNING lease_id;
")
echo "Synthetic lease created: $LEASE_ID"
```

Verify:
```bash
psql -h stg-pgbouncer -p 6432 -U admin -d hiveCentral \
  -c "SELECT lease_id, status, last_renewed_at FROM proposal.proposal_lease WHERE lease_id=$LEASE_ID;"
```

### 3.2 Simulate the agent going silent (SIGKILL with no heartbeat)

```bash
# The lease renewal cycle would normally update last_renewed_at every 30s.
# Instead, backdate last_renewed_at to simulate silence > 60s before failover_time:
psql -h stg-pgbouncer -p 6432 -U admin -d hiveCentral \
  -c "UPDATE proposal.proposal_lease SET last_renewed_at = now() - interval '120 seconds' WHERE lease_id=$LEASE_ID;"
```

### 3.3 Run failover (same as §2.3–2.4)

```bash
ssh stg-A1 sudo systemctl stop postgresql@16-main
bash scripts/dr/hivecentral-failover.sh
```

### 3.4 Verify orphan was released (AC7)

```bash
# The dr_orphan_lease_request row should be created by lease-reconcile.sql
psql -h stg-A2 -p 5432 -U admin -d hiveCentral \
  -c "SELECT request_status, requested_at FROM roadmap.dr_orphan_lease_request ORDER BY requested_at DESC LIMIT 1;"
# Expected: request_status='pending' (or 'complete' if tenant reconciler ran)

# Within 5 min the per-tenant reconciler should update it to 'complete':
psql -h stg-A2 -p 5432 -U admin -d hiveCentral \
  -c "SELECT COUNT(*) FROM roadmap.dr_orphan_lease_request WHERE request_status='pending' AND requested_at < now() - interval '5 min';"
# Expected: 0
```

If running a single-DB staging (tenant DB = hiveCentral), execute the tenant-side SQL directly to simulate the reconciler:

```sql
-- Run against the tenant DB (in v1 staging this IS hiveCentral):
UPDATE proposal.proposal_lease
   SET status='released', released_at=now(), released_reason='dr_failover_orphan'
 WHERE status='active'
   AND (last_renewed_at IS NULL OR last_renewed_at < NOW() - INTERVAL '60 seconds');
```

Then verify:
```bash
psql -h stg-A2 -p 5432 -U admin -d hiveCentral \
  -c "SELECT lease_id, status, released_reason FROM proposal.proposal_lease WHERE lease_id=$LEASE_ID;"
# Expected: status='released', released_reason='dr_failover_orphan'
```

### 3.5 Record result (AC7)

```bash
psql -U admin -h stg-A2 -p 5432 -d hiveCentral \
  -v event_kind='dr_drill' \
  -v operator='YOUR_NAME' \
  -v rpo_seconds='<measured>' \
  -v rto_seconds='<measured>' \
  -v decision_seconds='<measured>' \
  -v clock_skew_max='<measured>' \
  -v notes='"stuck-claim drill; 1 synthetic lease; orphan correctly released"' \
  -f /usr/local/share/agenthive/dr/record-dr-event.sql
```

### 3.6 Restore staging (same as §2.8)

---

## 4. RPO / RTO measurement methodology

### RPO

RPO = maximum data loss tolerated. In this topology (synchronous_commit=on), committed transactions are acknowledged only after replication to standby. The practical RPO proxy is **WAL bytes not yet replayed on standby at the moment of promotion**:

```sql
-- On standby (stg-A2), before promotion:
SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS replay_lag_bytes;
```

Mapping to seconds requires knowing write throughput. Under normal staging load (< 10 writes/s), 16 MB of unplayed WAL ≈ < 60 s. The failover script logs this value; the operator records it in the drill outcome.

### RTO

RTO = time from detection to first successful query via PgBouncer on the new primary.

- **T0**: Moment operator decides to run the failover script (recorded as `operator_decision_seconds` from the page).
- **T1**: `systemctl reload pgbouncer` completes (script step 4 log line).
- **T_verify**: First successful `SELECT 1` via PgBouncer after the flip (script step 5 output).

RTO = T_verify − T0 (detection time included in T0 since paging is the trigger).

### governance.decision_log payload schema for drills

```json
{
  "event_kind":               "dr_drill",
  "operator":                 "firstname.lastname",
  "drill_type":               "clean_failover | stuck_claim | backup_restore | cold_dr",
  "rpo_proxy_bytes":          12345,
  "rpo_seconds_upper_bound":  45,
  "rto_seconds":              187,
  "operator_decision_seconds": 28,
  "clock_skew_max_seconds":   2,
  "orphans_expected":         0,
  "orphans_released":         0,
  "notes":                    "..."
}
```

All numeric fields are required. Missing fields block AC4/AC5 verification by the gate.

---

## 5. NULL last_renewed_at test (edge case for AC11)

The lease-reconcile predicate is:
```sql
AND (last_renewed_at IS NULL OR last_renewed_at < cutoff.ts)
```

The stuck-claim drill covers the `< cutoff.ts` case. To explicitly exercise the `IS NULL` branch:

```bash
psql -h stg-pgbouncer -p 6432 -U admin -d hiveCentral \
  -c "INSERT INTO proposal.proposal_lease (proposal_id, agent_identity, claimed_at, last_renewed_at, status, lease_duration_seconds) VALUES (2, 'did:hive:spawn:stg-null-test:1', now(), NULL, 'active', 300) RETURNING lease_id;"
```

After reconciliation, assert this lease is also released.

---

## 6. External operator review checklist (AC14)

This section is to be completed by an operator **not on the primary on-call rotation** before P591 can be gated as complete.

| Item | Reviewer sign-off |
|---|---|
| Section 1 staging prerequisites are achievable with current hardware | [ ] |
| Section 2 clean drill procedure is unambiguous and executable | [ ] |
| Section 3 stuck-claim drill procedure produces a deterministic outcome | [ ] |
| Section 4 RPO/RTO measurement methodology matches the §1 targets in hivecentral-dr-design.md | [ ] |
| Section 4 governance.decision_log payload schema has all fields needed by gate automation | [ ] |
| `scripts/dr/hivecentral-failover.sh` step ordering (reconcile-then-flip) is correct | [ ] |
| `scripts/dr/lease-reconcile.sql` NULL-safe predicate is correct | [ ] |
| `scripts/dr/backup-restore-test.sh` smoke tests are sufficient | [ ] |

**Reviewer name:** ___________________  
**Date reviewed:** ___________________  
**Signature (or GitLab MR approval):** ___________________

Record of review must be logged as a `governance.decision_log` row with `entry_kind='dr_runbook_review'` and `payload.reviewer` set to the reviewer's DID or name before P591 is certified complete.

---

## 7. After-drill cleanup checklist

- [ ] Restore PgBouncer config to point at staging primary (`stg-A1`)
- [ ] `pg_basebackup` or WAL shipping re-established on the demoted host
- [ ] `governance.decision_log` drill row recorded (§2.7 or §3.5)
- [ ] Drill results communicated to #ops-dr Slack channel
- [ ] Any anomalies filed as issues against P591 (or successor)
- [ ] If RTO > 5 min or RPO > 60 s: file a P-ticket immediately before next drill
