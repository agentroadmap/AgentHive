# P501 Risk Assessment — hiveControl Bootstrap

**Assessment Date**: 2026-04-26  
**Scope**: DDL deployment only (no data migration)  
**Severity Baseline**: LOW (schema-only operation, zero service interruption)

---

## Top 5 Risks (Ranked by Severity × Likelihood)

### RISK #1: Schema Duplication in agenthive (SEVERITY: HIGH, LIKELIHOOD: CONFIRMED)

**Finding**: The live agenthive database contains **two parallel control-plane schemas**:
- `roadmap.*` — 76 base tables (audit_log, cubics, agent_profile, etc.) — LEGACY
- `roadmap_proposal.*` — 22 proposal tables (proposal, proposal_lease, etc.) — CANONICAL
- `roadmap_control`, `roadmap_efficiency`, `roadmap_messaging`, `roadmap_workforce` — specialized schemas

Both `roadmap.proposal` and `roadmap_proposal.proposal` exist with 319 rows each. Foreign keys are distributed across schemas inconsistently.

**Impact if Unmitigated**:
1. hiveControl bootstraps BOTH schemas, duplicating storage and complexity
2. Services must know which schema to query (proposal data from roadmap_proposal, not roadmap)
3. Post-cutover (P506), dropping the old roadmap.* tables requires careful coordination to avoid breaking services still referencing them
4. Logical replication (P502) may not handle both schemas symmetrically

**Mitigation**:
- **ACCEPT THIS RISK**: P501 faithfully clones both schemas; migration is not the place to fix schema design
- **Delegate cleanup**: Create P520 (schema rationalization post-migration) to drop duplicate roadmap.* tables after confirming ALL services use roadmap_proposal.*
- **Document the current state**: Add a DDL comment in hiveControl marking which schemas are canonical:
  ```sql
  COMMENT ON SCHEMA roadmap_proposal IS 'CANONICAL: control-plane proposal data; roadmap.* is legacy';
  COMMENT ON SCHEMA roadmap IS 'LEGACY: superceded by roadmap_proposal.*; slated for cleanup in P520';
  ```

**Acceptance Criteria for P501**: Schema duplication is documented; P520 proposal is created before P506 cutover.

---

### RISK #2: Sequence Enumeration Script Incompleteness (SEVERITY: HIGH, LIKELIHOOD: MEDIUM)

**Finding**: P501 captures sequence metadata in `roadmap.ddl_sequence_metadata`, but the cutover sequence-bump script (P505) must:
1. Enumerate all 101 sequences from the metadata
2. For each sequence, read its current max value from agenthive
3. Set hiveControl's sequence to max + 1000 (safety buffer)

If any sequence is missed or the script fails mid-run, new inserts into hiveControl will collide with agenthive sequences during the replication tail phase (P502), causing constraint violations.

**Impact if Unmitigated**:
- hiveControl inserts fail: "duplicate key value violates unique constraint"
- Services error; cutover must abort
- Data integrity loss (some writes to hiveControl, some still on agenthive, split-brain)

**Mitigation**:
- **Phase 3 of runbook enumerates all sequences**: Run query and verify count ≥ 101
- **P504 rehearsal tests sequence bumping**: dry-run the cutover script on clone; confirm all 101 sequences are bumped without collision
- **P505 commits the exact cutover script**: no improvisation; runbook contains the frozen script and expected output per sequence
- **Acceptance Criteria**: Script source code reviewed + committed; rehearsal output logged; zero sequences missed

---

### RISK #3: Logical Replication Setup Timing (SEVERITY: MEDIUM, LIKELIHOOD: MEDIUM)

**Finding**: P501 creates empty hiveControl; P502 sets up logical replication to tail agenthive. Between P501 (T=0) and P502 start (T=T502), hiveControl is empty and unconnected to agenthive.

If an operator manually inserts data into hiveControl before P502 starts, or if P502 fails to create the subscription, the initial_state may be inconsistent:
- agenthive has been written to by services (proposal IDs 320+)
- hiveControl snapshot is from P501 time (proposal ID 319)
- Replication lag is unknown

**Impact if Unmitigated**:
- hiveControl is out of sync on cutover
- Read-shadow (P503) detects inconsistencies
- Cutover aborted; cascade delay in timeline

**Mitigation**:
- **P502 MUST create subscription immediately after P501 succeeds**: no manual steps in between
- **CI gate blocks any writes to hiveControl between P501 and P502 go-live**: deployment blocks any service connecting to hiveControl env var until P502 completes
- **P503 validates zero-delta for 48h before cutover approval**: if any delta appears, cutover is blocked and root cause investigated
- **Acceptance Criteria**: P502 starts within 5 minutes of P501; subscription created in < 1 minute; replication lag = 0 within 10 minutes

---

### RISK #4: PgBouncer Configuration Collision (SEVERITY: MEDIUM, LIKELIHOOD: LOW)

**Finding**: Phase 5 of the runbook appends hiveControl pool to pgbouncer.ini and reloads. If pgbouncer.ini already has a malformed entry or PgBouncer was recently modified, RELOAD may fail or route connections incorrectly.

**Impact if Unmitigated**:
- `RELOAD` command hangs or errors
- PgBouncer restarts (cold, brief connection drop)
- Some services may be routed to wrong database temporarily
- Cutover window extends; operator confidence lost

**Mitigation**:
- **Pre-flight check (Phase 5.0)**: Verify current pgbouncer.ini syntax:
  ```bash
  psql -p 6432 pgbouncer -c "SHOW DATABASES;" | grep -q hiveControl
  ```
  If hiveControl already listed, use `RELOAD` without appending.
- **Verify reload succeeds**: Phase 5.2 smoke test confirms connection works
- **Acceptance Criteria**: RELOAD completes in < 5s; smoke test succeeds; no dropped connections (confirm by checking pg_stat_activity for disconnections)

---

### RISK #5: Disk Space Exhaustion During Dump/Restore (SEVERITY: MEDIUM, LIKELIHOOD: LOW)

**Finding**: Phase 2 dumps agenthive (152 MB actual size, ~14k lines of DDL) to /tmp. If /tmp is a small partition or filling up, the dump or restore may fail mid-operation.

**Impact if Unmitigated**:
- Dump completes but file is truncated (restore fails with "unexpected end of file")
- Restore fails partway through, leaving hiveControl in inconsistent state
- Operator must rollback and diagnose disk issue
- Timeline slip

**Mitigation**:
- **Pre-flight check (Phase 0.4)**: Verify /var/lib/postgresql has ≥ 300 MB free
- **Dump to /var/lib/postgresql/dump/ instead of /tmp**: More reliable on production systems
- **Monitor dump file size**: After Phase 2.1, confirm file size:
  ```bash
  du -h /tmp/control_schema_dump.sql
  # Expected: ~1.5–2 MB (DDL only, not data)
  ```
- **Acceptance Criteria**: Disk check passes; dump file > 1 MB and < 10 MB; restore completes without truncation

---

## Medium Risks (Severity or Likelihood Medium)

### RISK #6: Extension Dependencies (SEVERITY: MEDIUM, LIKELIHOOD: LOW)

**Finding**: agenthive has extensions:
- `pg_trgm` (text search)
- `vector` (pgvector, 0.8.2)
- `tablefunc` (in roadmap_proposal schema)

hiveControl bootstrap must include these extensions. If an extension version mismatch or missing dependency exists, schema creation may fail or behave differently.

**Mitigation**:
- **Dump includes extension creation**: `pg_dump --schema-only` emits `CREATE EXTENSION` statements
- **Pre-flight: Verify extensions loaded**: Phase 2.4 spot-check that extensions are present after restore
- **Acceptance Criteria**: All 4 extensions present in hiveControl with matching versions

---

### RISK #7: View Dependency Ordering (SEVERITY: LOW, LIKELIHOOD: LOW)

**Finding**: hiveControl has 30+ views (e.g., `v_proposal_full`, `v_proposal_queue`). Views depend on base tables. If base tables are not fully created before views, or if views reference dropped tables, restoration may fail.

**Impact if Unmitigated**:
- Restore errors like "relation does not exist" for view bodies
- hiveControl ends up with missing views
- Services querying views fail post-cutover

**Mitigation**:
- **pg_dump respects dependency order**: Tables before views
- **Phase 2.4 verifies view count**: Query `pg_views WHERE schemaname LIKE 'roadmap%'` and confirm ≥ 30
- **Acceptance Criteria**: All views created successfully; view count matches agenthive

---

### RISK #8: Cross-Schema Foreign Keys (SEVERITY: MEDIUM, LIKELIHOOD: MEDIUM)

**Finding**: 163 foreign keys exist in control schemas. Some may reference across schema boundaries (e.g., roadmap.project → roadmap_proposal.proposal). If both schemas are cloned faithfully but FK definitions diverge, inserts may fail post-cutover.

**Impact if Unmitigated**:
- On cutover, services insert rows into roadmap_proposal.proposal
- FK constraint enforces a lookup to roadmap.project
- If roadmap.project schema is out of sync, constraint fails

**Mitigation**:
- **Phase 4: Parity check includes FK definitions**: Verify all FK definitions match between agenthive and hiveControl
- **No cross-DB FKs**: FKs never point outside hiveControl (cross-DB FKs are forbidden in P429 architecture)
- **Acceptance Criteria**: Parity check confirms all FKs present and matching; no FK definition divergence

---

## Low Risks (Severity or Likelihood Low)

### RISK #9: Network Partition During Dump (SEVERITY: MEDIUM, LIKELIHOOD: VERY LOW)
If the network connection to agenthive drops mid-dump, the file is corrupted. Mitigation: re-run Phase 2.1. Acceptance: dump completes successfully in one attempt (rare).

### RISK #10: Manual Intervention Between Phases (SEVERITY: MEDIUM, LIKELIHOOD: LOW)
If operator makes manual changes to hiveControl between phases (e.g., adding a table), parity check fails. Mitigation: treat hiveControl as read-only between P501 start and P502 completion. Acceptance: parity check passes with zero manual changes.

---

## Critical Path Dependencies

**P501 blocking P502**: Yes  
- P501 must complete successfully before P502 can start logical replication setup

**P501 blocking P504 (rehearsal)**: Yes  
- Rehearsal runs same scripts on clone; validates sequence bumping

**P501 blocking P505 (cutover)**: Partially  
- P505 uses metadata from P501 (ddl_sequence_metadata) to freeze sequence-bump commands

**P501 blocking services**: No  
- Services remain on agenthive until P518 (cutover execution)

---

## Go/No-Go Checklist for P501 Completion

- [ ] Phase 0: All 5 pre-flight checks pass
- [ ] Phase 1: Database and roles created without error
- [ ] Phase 2: Schema dump+restore completes in < 30s each; no ERROR lines in restore output
- [ ] Phase 2.4: Table and index counts match agenthive (spot checks)
- [ ] Phase 3: ≥ 101 sequences enumerated and inserted into ddl_sequence_metadata
- [ ] Phase 4: Parity check passes (all tables, columns, indexes, FKs match)
- [ ] Phase 5: PgBouncer reload succeeds; smoke test connects to hiveControl via bouncer
- [ ] Phase 6: ddl_version stamped; final validation query returns correct counts
- [ ] **Runbook approval**: Frozen runbook reviewed by 2 senior DBAs; signed off
- [ ] **Timeline**: P502 start date confirmed; replication script ready
- [ ] **Escalation contact**: Named escalation contact acknowledged and on-call for P501 window

---

## Recommended Go-Live Readiness Score

**Current Score: 72/100** (after simulation + risk assessment, pre-rehearsal)

**Blockers to increase score**:
1. **P504 rehearsal must pass** (current blocker: 15 points) — validates sequence-bump script, parity on clone, timing
2. **P502 replication setup validated** (current blocker: 8 points) — subscription creation, lag monitoring, 48h tail verification
3. **Incident command structure named** (current blocker: 5 points) — operator, comms, escalation contact, on-call roster

**Score will be 85+ after P504 rehearsal passes and P505 plan freeze is committed.**

---

## Known Unknowns (Assumptions Made)

1. **Backup restoration time**: Assumed < 30s for 152 MB DB. Verify on actual infrastructure.
2. **PgBouncer reload impact**: Assumed zero connection drop. Verify with monitoring.
3. **Service startup on hiveControl**: Assumed services can reconnect to new DSN in < 30s. Verify with connection pooling tests.
4. **Logical replication lag**: Assumed negligible (< 100ms) during 48h tail. Verify with monitoring + P503.

---

## Escalation Matrix

| Condition | Severity | Action | Owner |
|-----------|----------|--------|-------|
| Phase dump hangs > 60s | CRITICAL | Kill dump, rollback, investigate network | DB-Deploy |
| Phase restore fails (ERROR) | CRITICAL | Rollback (DROP hiveControl), rerun after fix | DB-Deploy |
| Parity check fails (fatal) | CRITICAL | Halt P502, investigate schema divergence | Database Architect |
| Sequence count < 101 | HIGH | Halt P504 rehearsal, investigate enum script | DB-Deploy |
| PgBouncer RELOAD fails | HIGH | Halt Phase 5, manually restore pgbouncer.ini | Infra Ops |
| Disk space < 100 MB | HIGH | Halt P501, free disk space | Infra Ops |
| FK mismatch in parity | MEDIUM | Investigate FK source, document exception if acceptable | Database Architect |
| Extension mismatch | MEDIUM | Check version compatibility, proceed if acceptable | DB-Deploy |
| View ordering issue | LOW | Verify view count post-restore; re-dump if < 30 | DB-Deploy |

---

## Reference: Current Live State Inventory

**As of 2026-04-26 (simulation date)**:

| Metric | Value |
|--------|-------|
| agenthive size | 152 MB |
| Control schemas | 6 (roadmap, roadmap_proposal, roadmap_control, roadmap_efficiency, roadmap_messaging, roadmap_workforce) |
| Base tables | 76 (roadmap), 22 (roadmap_proposal), 1 (roadmap_control), 12 (roadmap_efficiency), 2 (roadmap_messaging), 18 (roadmap_workforce) |
| Views | 30+ |
| Indexes | 300+ |
| Sequences | 101 |
| Foreign keys | 163 |
| Max table size | 35 MB (audit_log) |
| Total control-plane rows | ~15,700 |
| Largest proposal count | 319 (roadmap.proposal + roadmap_proposal.proposal both at 319) |
| Connected services | 6 (agenthive-mcp, agenthive-orchestrator, agenthive-gate-pipeline, agenthive-state-feed, agenthive-a2a, agenthive-copilot-agency) |

---

## See Also

- **P429**: Architecture (two-database topology)
- **P501**: This proposal (DDL deployment)
- **P502**: Logical replication setup (tail phase)
- **P503**: Read-shadow validation (zero-delta gate)
- **P504**: Rehearsal on production clone (sequence-bump validation)
- **P505**: Cutover plan freeze (immutable runbook)
- **P506**: Post-cutover cleanup (drop duplicate schemas)
- **P520** (TBD): Schema rationalization (final deduplication)
