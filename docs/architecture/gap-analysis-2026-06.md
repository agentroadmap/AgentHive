# AgentHive Codebase Gap Analysis — June 2026

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

- AC-3 (TUI keyboard navigation) blocked on P674 (obsolete)
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

### GAP-6.1: Stale proposal references in docs 🟡 Medium

- `docs/pillars/1-proposal/product-roadmap.md` dated 2026-04-05, references 71 proposals
- Current count: 568 proposals — doc is 497 proposals behind
- Multiple docs reference obsolete proposals (P300, P674, P482)
- **Fix proposal:** P3798 (DEVELOP/mature)

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
