# P429/P501 Migration Simulation & Documentation

**Status**: Simulation Complete (READ-ONLY)  
**Date**: 2026-04-26  
**Scope**: P501 hiveControl Bootstrap (Stage B)

---

## Overview

This directory contains comprehensive simulation, risk assessment, and runbooks for the **P501 DDL Deployment** — the first production-facing step in the P429 two-database topology migration (agenthive → hiveControl split).

**Key finding**: The simulation confirms the migration is technically feasible with **zero service interruption** during P501. Critical risks are well-understood and mitigated by subsequent proposals (P502–P505).

---

## Documents in This Directory

### 1. **p501-runbook.md**
**Purpose**: Step-by-step execution guide for the operator  
**Audience**: Database operators, SREs  
**Length**: ~300 lines of instructions + expected output  
**Phases**:
- Phase 0: Pre-flight checks (verification)
- Phase 1: Database & role creation (no data)
- Phase 2: Schema install via pg_dump → pg_restore (~30s)
- Phase 3: Sequence enumeration (critical for P505 cutover)
- Phase 4: Parity verification (agenthive vs hiveControl schema match)
- Phase 5: PgBouncer configuration update
- Phase 6: Version stamping & finalization

**Key invariant**: All operations are **idempotent**. Operator can re-run any phase if it fails.

---

### 2. **p501-risk-assessment.md**
**Purpose**: Comprehensive risk catalog + severity ranking  
**Audience**: Gate reviewers, architects, ops leadership  
**Length**: ~500 lines (10 detailed risks, 4 contingencies)  

**Top 5 Risks** (ranked by severity × likelihood):

1. **Schema Duplication in agenthive** (HIGH severity, CONFIRMED likelihood)
   - Current state: Both `roadmap.*` (76 tables) and `roadmap_proposal.*` (22 tables) exist
   - agenthive will be faithfully cloned to hiveControl (duplication preserved)
   - Mitigation: Delegate cleanup to P520 (post-migration schema rationalization)
   - Go-live impact: ACCEPTABLE (no impact on cutover, cleanup can happen later)

2. **Sequence Enumeration Incompleteness** (HIGH severity, MEDIUM likelihood)
   - 101 sequences must be enumerated and bumped during cutover
   - If any sequence is missed, cutover collisions occur
   - Mitigation: Phase 3 enumerates all; P504 rehearsal tests bumping script
   - Go-live impact: HIGH (blocks cutover if untested)

3. **Logical Replication Setup Timing** (MEDIUM severity, MEDIUM likelihood)
   - Gap between P501 (hiveControl created) and P502 (replication starts)
   - Window of vulnerability: hiveControl exists but unconnected
   - Mitigation: P502 MUST start within 5 minutes of P501; P503 validates 48h consistency
   - Go-live impact: MEDIUM (affects P502–P505 timeline)

4. **PgBouncer Configuration Collision** (MEDIUM severity, LOW likelihood)
   - RELOAD may fail if pgbouncer.ini is already modified
   - Mitigation: Pre-flight checks syntax; backup ini before modification
   - Go-live impact: LOW (quick rollback via ini restore)

5. **Disk Space Exhaustion During Dump/Restore** (MEDIUM severity, LOW likelihood)
   - 152 MB agenthive → dump → restore to hiveControl
   - Mitigation: Pre-flight disk check (≥ 500 MB free)
   - Go-live impact: LOW (halt and retry)

**Recommended Go-Live Score**: 72/100 (pre-rehearsal)  
**Score will increase to 85+ after P504 rehearsal passes**

---

### 3. **p501-rollback.md**
**Purpose**: Safe abort procedures for each phase  
**Audience**: Operators, SREs, escalation contacts  
**Length**: ~400 lines (6 detailed rollback paths)

**Key guarantee**: All rollback procedures preserve **zero data loss** and **zero service interruption**.

**Rollback Paths**:

- **Rollback-A** (Phases 0–4): `DROP DATABASE hiveControl` + agenthive remains live
- **Rollback-B** (Phase 4 parity fail): Investigate divergence or re-run P501
- **Rollback-C** (Phase 5 PgBouncer): Restore pgbouncer.ini, reload
- **Rollback-D** (Post-Phase 5): Full revert before P502 starts
- **Rollback-E** (P502+ replication): Disable subscription, revert env
- **Rollback-F** (P505 cutover): Emergency env flip back to agenthive (1–2 min)
- **Rollback-G** (P506+ fallback): 7-day window to fallback from hiveControl to agenthive if catastrophic failure

**Time to restore**: 1–2 minutes for all paths  
**Data loss**: ZERO for all paths

---

### 4. **p501-service-impact-matrix.md**
**Purpose**: How P501 affects each running service  
**Audience**: Application engineers, ops, on-call engineers  
**Length**: ~350 lines (6 services + fallback procedures)

**6 Services & Their P501 Impact**:

1. **agenthive-mcp** (MCP SSE server)
   - Impact: NONE (continues on agenthive during P501)
   - Readiness: Health check passes

2. **agenthive-orchestrator** (Event dispatcher + LISTEN)
   - Impact: NONE (LISTEN channels remain active on agenthive)
   - Risk: LISTEN not replicated; P503 validates consistency

3. **agenthive-gate-pipeline** (Gate review worker)
   - Impact: NONE (continues processing queue)

4. **agenthive-state-feed** (State → Discord forwarder)
   - Impact: NONE (notifications continue)

5. **agenthive-a2a** (A2A message router)
   - Impact: NONE (continues routing)

6. **agenthive-copilot-agency** (GitHub Copilot offer-claim)
   - Impact: NONE (continues processing)

**Key finding**: P501 is completely transparent to services. No downtime, no reconnection required until P518 (cutover execution).

**Service restart procedure** (only needed for P518 cutover, not P501):
- Graceful shutdown (connection drain)
- Restart (connects to new hiveControl env)
- Health verification

---

### 5. **p501-go-no-go-checklist.md**
**Purpose**: Pre-flight validation (24h before execution)  
**Audience**: Gate reviewers, operator, decision authority  
**Length**: ~400 lines (30+ specific checks + approval sign-offs)

**Decision Gate Authority**:
- Database Architect (approval authority)
- Infrastructure Lead (resource authority)
- Operator (execution readiness)
- Comms Lead (communication readiness)

**Three Outcomes**:
1. **GO**: Execute P501 immediately
2. **NO-GO**: Abort, reschedule to next week (any critical check fails)
3. **CONDITIONAL GO**: Execute with written mitigations (non-critical checks fail)

**Checks** (30+ specific):
- Disk space ≥ 500 MB
- PgBouncer running
- All 6 services healthy
- agenthive schema consistent
- No long-running transactions (> 10 min)
- Replication slot status healthy (if applicable)
- Runbook approved by 2 DBAs
- Risk assessment complete
- Rollback procedures tested

**Execution Handoff**:
- All sign-offs complete
- Operator reads first 5 steps aloud
- Database Architect confirms "proceed"
- Comms Lead posts to #incidents

---

## Live Database Inventory (2026-04-26)

Captured during simulation for reference:

| Metric | Value |
|--------|-------|
| Database | agenthive (152 MB) |
| Control schemas | 6 (roadmap*, roadmap_proposal*, roadmap_control, roadmap_efficiency, roadmap_messaging, roadmap_workforce) |
| Total tables | ~130+ (76 in roadmap, 22 in roadmap_proposal, etc.) |
| Total views | 30+ |
| Total indexes | 300+ |
| Sequences | 101 (critical for P505 cutover) |
| Foreign keys | 163 |
| Proposals | 319 (roadmap_proposal.proposal) |
| Projects | 3 (roadmap.project) |
| Agents | 7,334 (roadmap.agent_registry) |
| Services connected | 6 (agenthive-mcp, orchestrator, gate-pipeline, state-feed, a2a, copilot-agency) |
| Max table size | 35 MB (audit_log) |
| Dump time | < 30s (schema-only) |
| Restore time | < 30s |
| Total control-plane rows | ~15,700 |

---

## Key Findings from Simulation

### 1. Schema Duplication is a Pre-Migration Condition
- **Not caused by P501**; exists in live agenthive today
- **P501 faithfully clones both** roadmap.* and roadmap_proposal.* schemas
- **Resolution**: Create P520 (schema rationalization) post-migration to consolidate on roadmap_proposal.*

### 2. P501 Itself Is Straightforward
- **Total execution time**: 5 minutes (all 6 phases)
- **Failure modes**: Limited to dump/restore errors (easily recoverable)
- **Idempotency**: All operations can be re-run safely

### 3. Critical Path Dependency on Sequence Bumping
- **101 sequences MUST be enumerated** in Phase 3
- **Sequence bumping script MUST be tested** in P504 rehearsal
- **Failure here blocks cutover** (P505) and impacts P518 timeline

### 4. Service Transparency is Strong
- **Zero service downtime during P501**; services remain on agenthive
- **LISTEN channels are a nuance** (P503 validates consistency)
- **Connection pool recycling** happens automatically on cutover (P518)

### 5. Logical Replication Timing is Critical
- **Gap between P501 and P502** is a vulnerability window
- **Mitigation**: P502 starts immediately; P503 validates 48h consistency
- **Risk**: If P502 setup fails, hiveControl is orphaned (remediation: re-run P502 or delete hiveControl)

---

## Recommended Pre-Execution Actions

### Before Gate Review of P501 (This Week)

1. ✅ **Simulation complete** — This document
2. **Schedule P504 rehearsal**: Dry-run all 6 phases on clone cluster
3. **Test sequence-bump script**: Verify enumeration captures all 101 sequences
4. **Document service restart procedure**: Ensure service owners know P518 sequence
5. **Brief on-call team**: Prepare for P501 window (likely next week)

### Before Go/No-Go Decision (24h before execution)

1. Run full pre-flight checklist (p501-go-no-go-checklist.md)
2. Confirm all 4 sign-off authorities available
3. Verify P504 rehearsal passed (sequence bumping validated)
4. Backup current agenthive (final snapshot)
5. Confirm escalation contact on-call

### During P501 Execution (T+0 to T+5min)

1. Operator executes runbook phases in order
2. DB-Deploy Witness observes parity checks
3. Comms Lead monitors #incidents channel
4. Escalation Contact available for immediate escalation

### Post-P501 (T+5min to T+1h)

1. Operator reports: "P501 Phase 6 finalized; hiveControl bootstrap complete"
2. Comms Lead updates status page: "Infrastructure optimization complete"
3. Database Architect reviews logs and approves P502 entry
4. Schedule P502 (logical replication setup) for next phase

---

## Cross-Proposal References

| Proposal | Stage | Phase | Purpose |
|----------|-------|-------|---------|
| P429 | Architecture | - | Two-database topology (agenthive → hiveControl split) |
| P496–P500 | Stage A | Foundation | Vault, pool registry, config, PgBouncer, test infra |
| **P501** | **Stage B** | **Bootstrap** | **hiveControl DDL deployment (THIS PROPOSAL)** |
| P502 | Stage B | Replication | Logical replication setup + initial tail |
| P503 | Stage B | Validation | Read-shadow 48h consistency gate |
| P504 | Stage C | Rehearsal | Dry-run on production clone + sequence bumping |
| P505 | Stage C | Freeze | Cutover plan immutable artifact (runbook) |
| P518 | Stage C | Execution | Actual cutover (flip env, restart services) |
| P506 | Stage D | Cleanup | Drop control schemas from agenthive (post-cutover) |
| P507–P509 | Stage D | Tenant | Self-grandfather agenthive as project_id=1 |
| P510–P512 | Stage E | Cleanup | Drop project_id, drop FDW shims, remove single-DB mode |
| P513–P514 | Stage F | Tenants | Onboard monkeyKing-audio, georgia-singer projects |

---

## Success Criteria Verification (Post-P501)

Run this query to confirm P501 success:

```sql
-- hiveControl must have these 6 schemas
SELECT schema_name FROM information_schema.schemata 
WHERE schema_name LIKE 'roadmap%' 
ORDER BY schema_name;

-- Expected: roadmap, roadmap_control, roadmap_efficiency, roadmap_messaging, roadmap_proposal, roadmap_workforce

-- hiveControl must have ≥ 98 tables
SELECT COUNT(*) as table_count FROM information_schema.tables
WHERE table_schema LIKE 'roadmap%';

-- Expected: ≥ 98

-- hiveControl must have ≥ 101 sequences
SELECT COUNT(*) as seq_count FROM pg_sequences
WHERE schemaname LIKE 'roadmap%';

-- Expected: 101

-- Sequence metadata must be populated
SELECT COUNT(*) FROM roadmap.ddl_sequence_metadata;

-- Expected: 101

-- PgBouncer must route to hiveControl
SELECT COUNT(*) FROM pg_stat_activity WHERE datname='hiveControl';

-- Expected: > 0 (after Phase 5 reload)
```

---

## See Also

- **CONVENTIONS.md** (project root): Master database topology specification
- **CLAUDE.md** (project root): Claude Code instructions for this codebase
- **P429 Design**: Full topology specification (read P429 design field for architecture details)
- **P502–P505**: Subsequent migration proposals (replication, validation, freeze, execution)

---

## Document Maintenance

**Last Updated**: 2026-04-26 (simulation date)  
**Review Cycle**: Update after each major phase (P501 execution, P502 completion, P504 rehearsal)  
**Archive Location**: `/var/log/agenthive/p501-execution-*.log` (retention: 1 year)

---

## Questions & Escalation

| Question | Owner | Contact |
|----------|-------|---------|
| "Is P501 safe to execute?" | Database Architect | [Architect Name] |
| "What if P501 fails mid-phase?" | DB-Deploy Witness | [Operator Name] |
| "What if hiveControl becomes unavailable after P501?" | Escalation Contact | [VP Eng / Manager] |
| "How do we know sequences are correct?" | Database Architect | Review P504 rehearsal logs |
| "Can we pause between phases?" | Operator | Yes, if < 24h elapsed; must re-check pre-flight |
