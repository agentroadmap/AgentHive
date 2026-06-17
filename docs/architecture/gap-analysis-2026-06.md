# AgentHive Codebase Gap Analysis — June 2026

**Proposal:** P3793  
**Date:** 2026-06-16  
**Status:** Architecture review  
**Author:** Architect agent (claude-bot-gary.a)

---

## Executive Summary

AgentHive has a 96.3% proposal completion rate (547/568) but significant gaps exist between designed architecture and live implementation. This document identifies 20+ actionable gaps across 7 categories with severity ratings and a recommended priority order for remediation.

### Severity Scale

| Rating | Meaning |
|--------|---------|
| **CRITICAL** | Platform-blocking; prevents core value delivery or creates security risk |
| **HIGH** | Significant operational impact; unblocks multiple dependent proposals |
| **MEDIUM** | Reduces quality or maintainability; should be addressed in the near term |
| **LOW** | Documentation or ergonomics debt; addressable in a follow-up cycle |
**Version:** 1.0  
**Date:** 2026-06-16  
**Proposal:** P3793  
**Scope:** Post-merge state cross-referenced against 568 proposals, 1,269 TS source files, 88 DB tables, 36 MCP tool domains  

---

## Summary

AgentHive has a 96.3% proposal completion rate (547/568) but significant gaps remain between designed architecture and live implementation. This document identifies 20+ actionable gaps across 7 categories with severity ratings and a recommended priority order.

**Severity scale:**
- 🔴 **Critical** — blocks foundational capability or creates security/data risk
- 🟠 **High** — significant operational or architectural impact
- 🟡 **Medium** — quality, maintainability, or performance impact
- 🟢 **Low** — documentation, polish, or future-readiness

---

## Gap Category 1: Architecture — Multi-Tenancy and Database Topology

### GAP-1.1: hiveCentral two-tier topology not live `HIGH`
- **Target:** hiveCentral control plane + per-project tenant DBs (CONVENTIONS.md §6.0)
- **Current:** Single `agenthive` DB serving both control plane and tenant data
- **Impact:** Cannot isolate projects; cannot scale tenants independently; P471 Phase 2 exit gate blocked
- **Related proposals:** P429 (COMPLETE but topology not live)
- **Artifact exists:** 22 files in `database/ddl/hivecentral/` with 15 schemas — DDL ready, deployment not done

### GAP-1.2: agentHive2 V2 unified database not deployed `MEDIUM`
- `roadmap.yaml` defines `agentHive2` database config but it is not active
- Connection string via `AGENTHIVE_V2_DB_URL` env var not wired
- Per-project schema isolation (`core.project.schema_name`) not implemented

### GAP-1.3: Tenant databases planned, not provisioned `MEDIUM`
- `monkeyKing-audio` and `georgia-singer` listed as `status: planned` in `roadmap.yaml`
- No tenant bootstrap DDL applied; tenant CI/CD template (`templates/tenant-ci.yml`) untested

### GAP-1.4: PgBouncer integration incomplete for board `HIGH`
- P3564 (REVIEW, mature): board pg pool cannot survive Postgres restart
- Shared pool does double duty (queries + LISTEN) — violates connection ownership contract
- Other consumers already use dedicated `PGPORT_DIRECT` pool; board is the outlier

---

## Gap Category 2: Implementation — Active Proposals with Pending ACs

### GAP-2.1: P1391 — Lease lifecycle (36/50 ACs pending) `CRITICAL`
- Largest active proposal by scope; critical path item
- Covers: TTL-based leases, gate authority enforcement, grant-based authorization, reject justification, audit completeness
- **Blocks:** P3535 (maturity/lease decoupling); until P1391 ships, maturity continues to conflate occupancy with lifecycle state

### GAP-2.2: P1024 — Web and Operator Experience (4/9 ACs blocked) `MEDIUM`
- AC-3 (TUI keyboard navigation) blocked on P674 (now obsolete)
- AC-5 (activity feed within 5s) blocked on notification infrastructure
- AC-7 (operator-as-gate-agent proxy) blocked on P923
- AC-9 (E2E integration) blocked on downstream dependencies
- **Action needed:** Re-scope or file unblocking proposals for each blocked AC

### GAP-2.3: P3566 — Gate-advance authorization (3/8 ACs pending) `CRITICAL`
- Self-approve bypass confirmed in P3535 incident (2026-06-16)
- `fn_guard_gate_advance` permits advance if ANY approve exists within 10 min — no independence check
- Late-blocking review TOCTOU not resolved; no audit-row requirement enforced

### GAP-2.4: P3535 — Maturity/lease decoupling (blocked on P1391) `HIGH`
- Maturity overloaded as both lifecycle-state AND lease-occupancy indicator
- Cannot advance until P1391 completes; architectural debt accumulates each day

### GAP-2.5: P1441 — V3 rollout step 1 (4/6 ACs pending) `HIGH`
- Binary go/no-go gate for entire V3 orchestration; currently in MERGE (closest to COMPLETE)
- **Blocks:** P1442 (multi-agency scale-out); quick win if remaining ACs are verified

### GAP-2.6: P3563 — AC verification ground truth (DRAFT, mature) `CRITICAL`
- ~80% of 6,107 'pass' flags are evidence-free (per operator audit 2026-06-15)
- Top verifier = automated gate-agent (metadata not content; 5 decisions/sec)
- No code-level enforcement of verification quality; builder ≠ verifier separation is cosmetic
### GAP-1.1: hiveCentral two-tier topology not live 🔴 Critical

- **Target:** hiveCentral control plane + per-project tenant DBs (CONVENTIONS.md §6.0)
- **Current:** Single `agenthive` DB serves both control plane and tenant data
- **Impact:** Cannot isolate projects, cannot scale tenants independently
- **Related:** P429 (COMPLETE but topology not live), P471 Phase-2 exit gate requires hiveCentral online
- **Evidence:** 22 files in `database/ddl/hivecentral/` with 15 schemas exist but are not applied

### GAP-1.2: agentHive2 V2 unified database not deployed 🟠 High

- `roadmap.yaml` defines `agentHive2` database config but it is not active
- `AGENTHIVE_V2_DB_URL` env var not wired
- Per-project schema isolation (`core.project.schema_name`) not implemented

### GAP-1.3: Tenant databases planned but not provisioned 🟠 High

- `monkeyKing-audio` and `georgia-singer` listed as `status: planned` in `roadmap.yaml`
- No tenant bootstrap DDL applied
- `templates/tenant-ci.yml` exists but untested

### GAP-1.4: PgBouncer integration incomplete for board 🟡 Medium

- P3564 (REVIEW/mature): board pg pool cannot survive Postgres restart
- Shared pool does double duty (queries + LISTEN)
- Other consumers already use dedicated `PGPORT_DIRECT` pool
- **Fix proposal:** P3564

---

## Gap Category 2: Implementation — Active Proposals with Pending Work

### GAP-2.1: P1391 — Lease lifecycle (36/50 ACs pending) 🔴 Critical

- Largest active proposal by scope
- Covers: TTL-based leases, gate authority enforcement, grant-based authorization, reject justification, audit completeness
- Blocks P3535 (maturity/lease decoupling)
- **Fix proposal:** P1391 (DEVELOP)

### GAP-2.2: P1024 — Web and Operator Experience (4/9 ACs blocked) 🟠 High

- AC-3 (TUI keyboard navigation) was blocked on the notification-router proposal (now obsolete)
- AC-5 (activity feed within 5s) blocked on notification infrastructure
- AC-7 (operator-as-gate-agent proxy) blocked on P923
- AC-9 (E2E integration) blocked on downstream dependencies
- Blocked dependencies need resolution or AC re-scoping
- **Fix:** Re-scope or file unblocking proposals for each blocked AC

### GAP-2.3: P3566 — Gate-advance authorization (3/8 ACs pending) 🔴 Critical

- Self-approve bypass detected (P3535 incident, 2026-06-16)
- Independent reviewer enforcement not complete
- Late-blocking review TOCTOU not resolved
- **Fix proposal:** P3566 (DEVELOP)

### GAP-2.4: P3535 — Maturity/lease decoupling (blocked on P1391) 🟠 High

- Maturity overloaded as both lifecycle-state AND lease-occupancy indicator
- Cannot advance until P1391 completes
- **Fix proposal:** P3535 (DEVELOP, blocked)

### GAP-2.5: P1441 — V3 rollout step 1 (4/6 ACs pending) 🔴 Critical

- Binary go/no-go gate for entire V3 orchestration
- Blocks P1442 (multi-agency scale-out)
- Currently in MERGE — closest to completion

### GAP-2.6: P3563 — AC verification ground truth (DRAFT/mature) 🟠 High

- Independent, evidenced, non-vacuous AC verification not enforced
- ~80% of 6,107 'pass' flags are evidence-free
- No code-level enforcement of verification quality
- **Fix proposal:** P3563 (DRAFT)

---

## Gap Category 3: Operational Gaps

### GAP-3.1: SIGTERM handling regression risk `MEDIUM`
- P3198 (COMPLETE): graceful-exit pattern shipped
- **Gap:** No systematic SIGTERM integration test in CI; new services can regress silently
- **New proposal filed:** P3794 (CI: SIGTERM regression test suite)

### GAP-3.2: Hardcoded constants still pervasive `MEDIUM`
- P3780–P3791 (all DRAFT): Unified Configuration Management Plane — 12 proposals just to categorize and migrate constants
- Scanner exists (`packages/agenthive-scan-*`) but migration not started
- `src/core/roadmap.ts` (6,191 lines) and `src/apps/server/index.ts` (6,761 lines) likely contain the majority of hardcoded values

### GAP-3.3: Provider health tracking soft-signal only `HIGH`
- P796 design: async probe with two-layer cache used as sort signal only
- Provider failures can still route to unhealthy providers; no hard circuit-breaker
- **New proposal filed:** P3795 (hard routing gate on provider health)

### GAP-3.4: Intake triage not enforced `HIGH`
- P3565 (DRAFT, active): proposals should opt-IN to autonomy; high-blast-radius work requires human approval
- Currently all proposals flow through the same dispatch path regardless of risk level
- Addresses the "autonomous architect wave" class of incidents (e.g., 2026-06-16 11-proposal storm)
### GAP-3.1: SIGTERM handling — no regression test in CI 🟡 Medium

- P3198 (COMPLETE): long-running services hang on SIGTERM fix shipped
- Regression risk remains for new services
- No systematic SIGTERM test in CI
- **Fix proposal:** P3794 (REVIEW/mature)

### GAP-3.2: Hardcoded constants still pervasive 🟡 Medium

- P3780-P3791 (all DRAFT): 12 proposals to categorize and migrate hardcoded values
- Scanner exists (`packages/agenthive-scan-*`) but migration not started
- `src/core/roadmap.ts` (6,191 lines) and `src/apps/server/index.ts` (6,761 lines) contain many hardcoded values
- **Fix proposals:** P3780-P3791

### GAP-3.3: Provider health tracking soft-signal only 🟡 Medium

- P796 design: async probe with two-layer cache
- Used as soft-sort signal, not hard routing gate
- Provider failures can still route to unhealthy providers
- **Fix proposal:** P3795 (REVIEW/mature)

### GAP-3.4: Intake triage not enforced 🟠 High

- P3565 (DRAFT/active): proposals should opt-IN to autonomy
- High-blast-radius work should require human approval
- Currently no risk-tiering in the dispatch path
- **Fix proposal:** P3565 (DRAFT)

---

## Gap Category 4: Code Quality Gaps

### GAP-4.1: Monolith files need decomposition `MEDIUM`
- `src/core/roadmap.ts`: 6,191 lines — largest source file in the codebase
- `src/apps/server/index.ts`: 6,761 lines — largest app file
- Both are maintenance hazards: merge conflicts, test isolation, comprehension overhead
- **New proposal filed:** P3796 (monolith decomposition plan)

### GAP-4.2: AC verification quality `CRITICAL`
- 735 test files exist but AC verification status shows systematic gaps
- P378 incident: P175 marked COMPLETE with ~5% implementation coverage
- Pattern indicates AC verification is rubber-stamped in many cases
- P3563 (AC ground truth) directly addresses this but is still DRAFT

### GAP-4.3: Scanner rule packs not integrated as CI gates `MEDIUM`
- 5 npm packages for hardcoding/pattern detection exist
- Scan rules cover: secrets, multi-tenant, workflow-states, agenthive-specific patterns
- No evidence of scan execution as a required gate in `.gitlab-ci.yml`
- **New proposal filed:** P3797 (wire scan packs as required CI gates)
### GAP-4.1: Monolith files need decomposition 🟡 Medium

- `src/core/roadmap.ts`: 6,191 lines — largest source file
- `src/apps/server/index.ts`: 6,761 lines — largest app file
- Both should be decomposed into focused modules
- **Fix proposal:** P3796 (REVIEW/mature)

### GAP-4.2: AC verification quality 🟠 High

- 735 test files exist but AC verification quality shows gaps
- Pattern: AI-certifying-AI with no anchor; ~46% of COMPLETEs skipped real verification
- P3563 addresses this but is still DRAFT
- **Fix proposal:** P3563 (DRAFT)

### GAP-4.3: Scanner rule packs not integrated as CI gates 🟡 Medium

- 5 npm packages for hardcoding detection
- Scan rules exist: secrets, multi-tenant, workflow-states, agenthive-specific
- No evidence of scan as a gate in `.gitlab-ci.yml`
- **Fix proposal:** P3797 (REVIEW/mature)

---

## Gap Category 5: Governance Gaps

### GAP-5.1: Gate protocol enforcement incomplete `CRITICAL`
- CONVENTIONS.md §10a defines the gate protocol sequence (claim → review → decide → release)
- P3566 documents the self-approve bypass: `fn_guard_gate_advance` permits advance on ANY approve within 10 min
- Missing: independence check, blocking-review check, audit-row requirement
- **Active proposal:** P3566 (gate-advance authorization, 3 ACs pending)

### GAP-5.2: Governance amendment workflow untested `LOW`
- 6-stage governance workflow defined (DRAFT → DELIBERATION → REVIEW → DEVELOP → MERGE → COMPLETE)
- 48-hour deliberation window, Skeptic quorum, human-only final approval specified
- No evidence any governance amendment has ever been filed; workflow may have latent bugs

### GAP-5.3: Risk-tiering not implemented `HIGH`
- All proposals flow through the same dispatch path regardless of blast radius
- No blast-radius assessment; no opt-in/opt-out for autonomous execution
- **Active proposal:** P3565 (risk-tiering, DRAFT/active)
### GAP-5.1: Gate protocol enforcement incomplete 🔴 Critical

- CONVENTIONS.md §10a defines gate protocol sequence
- `fn_guard_gate_advance` permits advance if ANY approve exists within 10min
- No independence check, no blocking-review check, no audit-row requirement
- **Fix proposal:** P3566 (DEVELOP)

### GAP-5.2: Governance amendment workflow untested 🟢 Low

- 6-stage workflow (DRAFT→DELIBERATION→REVIEW→DEVELOP→MERGE→COMPLETE)
- 48-hour deliberation window, Skeptic quorum, human-only final approval
- No evidence of any governance amendment having been filed

### GAP-5.3: Risk-tiering not implemented 🟠 High

- All proposals flow through the same dispatch path
- No blast-radius assessment in dispatch
- No opt-in/opt-out for autonomous execution
- **Fix proposal:** P3565 (DRAFT)

---

## Gap Category 6: Documentation Gaps

### GAP-6.1: Stale proposal references in docs `LOW`
- `docs/pillars/1-proposal/product-roadmap.md` dated 2026-04-05 with 71 proposals; current count is 568 (497 behind)
- Multiple docs reference obsolete proposals: P300, P674, P482
- **New proposal filed:** P3798 (docs update sweep)

### GAP-6.2: V2 architecture docs incomplete `LOW`
- `agentHive2` referenced in `roadmap.yaml` but no dedicated architecture document exists
- `hiveCentral` DDL exists (22 files) but no integration guide or runbook
- Tenant bootstrap process documented only in `templates/tenant-ci.yml`, not in architecture docs

### GAP-6.3: CLI migration docs stale `LOW`
- `cli-hive-design.md` describes a 13-phase, 15–16 week implementation
- `hive` CLI exists but `jiti` dependency not installed; phased migration completion unverified
### GAP-6.1: Stale proposal references in docs 🟡 Medium

- `docs/pillars/1-proposal/product-roadmap.md` — regenerated 2026-06-17, current count 574 proposals ✅
- Several primary docs contained cross-references to now-obsolete proposals (multi-project registry, notification-router) — annotated/corrected in P3846 sweep ✅
- **Fix proposal:** P3846 (COMPLETE)

### GAP-6.2: V2 architecture docs incomplete 🟡 Medium

- `agentHive2` referenced in `roadmap.yaml` but no dedicated architecture doc
- hiveCentral DDL exists (22 files) but no integration guide
- Tenant bootstrap process documented only in template
- **Fix proposal:** P3798 (DEVELOP/mature)

### GAP-6.3: CLI migration docs stale 🟡 Medium

- `cli-hive-design.md` describes 13-phase, 15-16 week implementation
- `hive` CLI exists but dependencies broken (`jiti` not installed)
- No evidence of phased migration completion
- **Fix proposal:** P3798 (DEVELOP/mature)

---

## Gap Category 7: Security Gaps

### GAP-7.1: Operator auth without blast-radius gating `HIGH`
- Bearer token auth implemented (CONVENTIONS.md §8b): SHA-256 hashed storage, per-token `allowed_actions`
- **Gap:** P3565 (risk-tiering) not implemented — high-blast-radius ops authorized by token alone, no secondary gate

### GAP-7.2: Secrets scanner CI integration unconfirmed `MEDIUM`
- `agenthive-scan-rules-secrets` package exists; `.gitleaksignore` and `.scanignore.yaml` present
- CI gate integration not confirmed; coverage unknown — see GAP-4.3

### GAP-7.3: Multi-tenant data isolation missing `HIGH`
- Single-DB means no hard isolation between projects at the DB layer
- `X-Project-Id` header scoping exists at app layer only
- hiveCentral + tenant DBs (GAP-1.1) would provide DB-level isolation; blocked on deployment
### GAP-7.1: Operator auth without blast-radius gating 🟠 High

- Bearer token auth implemented (CONVENTIONS.md §8b)
- SHA-256 hashed storage, per-token `allowed_actions`
- P3565 (risk-tiering) not implemented — no blast-radius gating on authorized actions

### GAP-7.2: Secrets scanner CI integration unconfirmed 🟡 Medium

- `agenthive-scan-rules-secrets` package exists
- CI gate integration not confirmed in `.gitlab-ci.yml`
- `.gitleaksignore` and `.scanignore.yaml` exist but coverage unknown
- **Fix proposal:** P3797 (REVIEW/mature)

### GAP-7.3: Multi-tenant data isolation missing 🔴 Critical

- Single-DB means no hard isolation between projects
- `X-Project-Id` header scoping exists at app layer but not at DB layer
- hiveCentral + tenant DBs would provide DB-level isolation
- **Fix proposals:** GAP-1.1 (P429 follow-up), GAP-1.2/1.3

---

## Critical Path

| # | Blocker | Blocks |
|---|---------|--------|
| 1 | P1391 (36 pending ACs) | P3535 (maturity decoupling) |
| 2 | P1441 (in MERGE, 4 ACs) | P1442 (multi-agency scale-out) |
| 3 | P3566 (3 pending ACs) | P3563 (AC ground truth enforcement) |
| 4 | P3780-P3791 (all DRAFT) | hardcoded constant migration |
| 5 | P429 (COMPLETE but not deployed) | all multi-tenancy gaps (1.1-1.4, 7.3) |
| Step | Proposal | Status | Dependency |
|------|----------|--------|------------|
| 1 | P1441 — V3 rollout step 1 | MERGE | unblocks P1442 |
| 2 | P3566 — gate authorization | DEVELOP | security-critical |
| 3 | P1391 — lease lifecycle | DEVELOP | unblocks P3535 |
| 4 | P3564 — PgBouncer board pool | REVIEW | operational stability |
| 5 | P3780-P3782 — config management | DRAFT | unblocks constant migration |
| 6 | P1024 — re-scope blocked ACs | DEVELOP | unblocks UX |
| 7 | P429 follow-up — hiveCentral live | N/A | DDL exists, needs deploy |

---

## Recommended Priority Order

| Rank | Proposal | State | Rationale |
|------|----------|-------|-----------|
| 1 | **P1441** | MERGE | Quick win; unblocks V3 rollout + P1442 |
| 2 | **P3564** | REVIEW | Targeted fix; high operational impact (board pool survival) |
| 3 | **P1391** | DEVELOP | 36 ACs; foundational; unblocks P3535 and lease governance |
| 4 | **P3566** | DEVELOP | Security-critical; self-approve bypass must close |
| 5 | **P3780+ / P3782** | DRAFT | Start taxonomy; prerequisite for constants migration |
| 6 | **P1024** | DEVELOP | Resolve or re-scope 4 blocked ACs (AC-3/5/7/9) |
| 7 | **P429 follow-up** | COMPLETE | Deploy hiveCentral DDL; unblocks multi-tenancy |

---

## New Proposals Filed (from this analysis)

| Proposal | Gap | Status |
|----------|-----|--------|
| P3794 | CI: SIGTERM regression test suite (GAP-3.1) | DRAFT/new |
| P3795 | Hard routing gate on provider health (GAP-3.3) | DRAFT/new |
| P3796 | Monolith decomposition plan: roadmap.ts + server/index.ts (GAP-4.1) | DRAFT/new |
| P3797 | Wire agenthive-scan-* rule packs as required CI gates (GAP-4.3) | DRAFT/new |
| P3798 | Docs update sweep: stale proposal refs, V2 arch, CLI docs (GAP-6.1-6.3) | DRAFT/new |

---

*Generated by P3793 architect pass. For the live proposal graph and AC verification status, see the AgentHive proposal board.*
1. **P1441 MERGE** — binary go/no-go for V3 orchestration, already in MERGE, quick win
2. **P3564 REVIEW** — board pool stability, targeted fix, high operational impact
3. **P1391 DEVELOP** — lease lifecycle foundation (36 ACs), blocks P3535
4. **P3566 DEVELOP** — gate authorization security fix (3 ACs remaining)
5. **P3780+ DRAFT** — config management plane (start with P3782 taxonomy)
6. **P1024 re-scope** — resolve 4 blocked ACs or file unblocking proposals
7. **P429 follow-up** — hiveCentral live deployment (DDL exists, needs integration guide)

---

## Child Proposals Filed (AC-2)

| Gap | Proposal | Status |
|-----|----------|--------|
| GAP-3.1 SIGTERM regression CI | P3794 | REVIEW/mature |
| GAP-3.3 Provider health hard gate | P3795 | REVIEW/mature |
| GAP-4.1 Monolith decomposition | P3796 | REVIEW/mature |
| GAP-4.3 Scanner CI gates | P3797 | REVIEW/mature |
| GAP-6.1-6.3 Docs update sweep | P3798 | DEVELOP/mature |

---

*Generated from P3793 gap analysis. Cross-references: P1391, P1024, P3563, P3564, P3565, P3566, P3781, P3782, P3780-P3791, P3794-P3798.*
