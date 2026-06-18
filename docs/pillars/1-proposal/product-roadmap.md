# 🗺️ AgentHive Roadmap

> Generated: 2026-06-17 (doc sweep P3846) | Source: Postgres `agenthive` | 768+ total rows (non-obsolete counts: SQL regeneration required — see "How to Regenerate")

## How to Regenerate

Run against the live DB to refresh this file:

```sql
-- Summary by state + maturity (non-obsolete)
SELECT status, maturity, COUNT(*) AS count
FROM roadmap.proposal
WHERE maturity != 'obsolete'
GROUP BY status, maturity
ORDER BY status, maturity;

-- Active proposals (not obsolete, not COMPLETE) for the detailed sections below
SELECT display_id, title, status, maturity
FROM roadmap.proposal
WHERE status != 'COMPLETE' AND maturity != 'obsolete'
ORDER BY status, display_id;
```

Connection: `postgresql://admin:<PGPASSWORD>@127.0.0.1:5432/agenthive`

---

## Summary (non-obsolete)

> ⚠️ Counts below are approximate as of 2026-06-17. Run the SQL in "How to Regenerate" for exact numbers — significant new proposals (P3781–P3846 group) were added since the 2026-06-16 snapshot.

| State | Count | Notes |
|-------|-------|-------|
| ✅ COMPLETE | 596 total rows | Non-obsolete sub-count requires SQL; ~547+ non-obsolete |
| 🔀 MERGE | 1 | In integration |
| 🔨 DEVELOP | 10+ active | Config-mgmt group (P3781/4/5/7), gap-analysis group (P3793/4/6/7/8), P3840, plus legacy (P1391, P3535, P1024, P1442, P2326) |
| 🔍 REVIEW | 2+ | P3795 (provider health), P3564 (pgbouncer pool) |
| 📝 DRAFT | 8+ | P3563, P3565, P3782, P3839–P3846 |
| ⚪ Obsolete | 191+ | Across all states — superseded or invalidated; excludes P3566-test fixture storm (~40 rows) |
| **Total** | **768+** | |

---

## 🔬 Gap Analysis (P3793 — 2026-06-16)

Proposal **P3793** (Codebase Gap Analysis) identified six gap families driving the P37xx/P38xx proposal group:

| Gap | Description | Child Proposals |
|-----|-------------|----------------|
| GAP-1 | hiveCentral not live — single `agenthive` DB serves both control-plane and tenant data | P429 (DDL COMPLETE, deploy blocked) |
| GAP-2 | Provider health hard-routing — unhealthy providers still receive dispatch | P3795/P3843 |
| GAP-3 | SIGTERM regression CI suite missing | P3794/P3842 |
| GAP-4 | CI gate for scanner rule packs not wired in `.gitlab-ci.yml` | P3797/P3845 |
| GAP-5 | Monolith decomposition plan needed (roadmap.ts 6 191 lines, server/index.ts 6 761 lines) | P3796/P3844 |
| GAP-6 | Documentation stale — proposal references, V2 arch docs, CLI migration docs | P3798, **P3846 (this sweep)** |

P3846 (this doc sweep) closes GAP-6: it updates this roadmap file, adds `docs/architecture/hivecentral-integration-guide.md`, and verifies CLI design doc currency.

---

## 🔀 MERGE (1)

| ID | Title | Maturity |
|----|-------|---------|
| P1441 | V3-C9: Rollout step 1 — claude-gary-bot single agency, 1→N workers (e2e gate) | new |

---

## 🔨 DEVELOP (10+ active)

| ID | Title | Maturity |
|----|-------|---------|
| P3840 | Unified orchestrator job-posting pool (no auto-gating) | active |
| P3793 | Codebase Gap Analysis: architecture, implementation, operational, and governance gaps | mature |
| P3798 | Docs update sweep: stale proposal references, V2 architecture, CLI migration | mature |
| P3797 | Wire agenthive-scan-* rule packs as required CI gates in .gitlab-ci.yml | mature |
| P3796 | Monolith decomposition plan: roadmap.ts (6191 lines) and server/index.ts (6761 lines) | new |
| P3794 | CI: SIGTERM regression test suite for long-running services | mature |
| P3787 | Hardcoded-constant migration: inventory + move high-value core/infra literals into runtime flags | active |
| P3785 | Web config interface: category-grouped browse + audited inline edit in dashboard | new |
| P3784 | Config introspection API: list all config keys with category, value, default, scope, editability | mature |
| P3781 | Configuration Management: categorize runtime_flag, web config UI, and hardcoded-constant migration | new |
| P1391 | Lease lifecycle as TTL + first-class hold/reject verdict wiring | mature |
| P3535 | Decouple maturity lifecycle from lease occupancy — monotonic progress + lease-based exclusive claim | mature |
| P1024 | Pillar 8: Web and Operator Experience — Dashboard, Operator CLI, TUI Board, Activity Feed, Discord Bridge | new |
| P1442 | V3-C10: Rollout steps 2-4 — multi-agency, multi-OS-user, multi-host | new |
| P2326 | Ad-hoc A2A task bucket (sentinel proposal for no-proposal task_requests) | new |

---

## 🔍 REVIEW (2 active)

| ID | Title | Maturity |
|----|-------|---------|
| P3564 | Board pg pool doesn't survive a Postgres restart — route queries via pgbouncer + auto-heal pool | mature |
| P3795 | Hard routing gate on provider health — block dispatch to unhealthy providers | new |

---

## 📝 DRAFT (8+ active)

| ID | Title | Maturity |
|----|-------|---------|
| P3563 | Acceptance loop must have ground truth: independent, evidenced, non-vacuous AC verification as a hard gate invariant | mature |
| P3565 | Intake triage + risk-tiering: proposals opt-IN to autonomy, high-blast-radius work requires human approval | mature |
| P3782 | Config taxonomy: add category to runtime_flag schema + ConfigKey registry + set() schema reconciliation, backfill existing keys | active |
| P3839 | Gating-as-a-job: mature proposals must post a claimable gate-decision job at every gate (D1-D4) | new |
| P3841 | Enforce revised P996 agent naming — clean-slate re-registration + validator | new |
| P3842 | SIGTERM regression CI test suite for long-running services | mature |
| P3843 | Provider health hard-routing gate: block dispatch to unhealthy providers | mature |
| P3844 | Monolith decomposition plan: roadmap.ts (6 191 lines) and server/index.ts (6 761 lines) | mature |
| P3845 | Scanner rule packs as mandatory CI gates in .gitlab-ci.yml | new |
| P3846 | Documentation update sweep: fix stale proposal references, V2 arch gaps, and CLI migration docs | active |

---

## ✅ COMPLETE (596 total rows; ~547+ non-obsolete)

596 total rows are in COMPLETE state (includes all maturities). Full listing via MCP or direct DB query:

```sql
SELECT display_id, title
FROM roadmap.proposal
WHERE status = 'COMPLETE' AND maturity != 'obsolete'
ORDER BY id DESC
LIMIT 50;
```

**Most recently completed (top-20 by proposal ID):**

| ID | Title |
|----|-------|
| P3782 | Config taxonomy: add category to ConfigKey registry and runtime_flag schema |
| P3566 | Gate-advance authorization integrity (non-terminal gates) |
| P3508 | Multi-project access control — project-creation ACLs + token/route scoping |
| P3326 | gate_decision D2 advance target + prop_transition validator |
| P1107 | Wire AC-8 CI gates — mcp-bundle + message-drift + migration-continuity |
| P1071 | Close unclosed it() block in AC-4 self-parent test |
| P477 | Web control-plane redesign (partially — routing layer complete) |
| P3198 | SIGTERM clean-exit handler for long-running services |
| P2496 | Retract-on-terminal-state trigger |
| P1456 | Route all LISTEN/NOTIFY through agentNotifyChannel() |
| P1144 | Orchestrator dead-const cleanup |
| P893 | System-init deploy scripts |
| P3310 | Difficulty signal for adaptive work-model matching |
| P3311 | Beta-Bernoulli reliability ledger |
| P3312 | Unified matcher shadow-wiring |
| P3313 | Closed feedback loop for adaptive matching |
| P1376 | Agency-aware cooldown filter + throttle resolver |
| P1356 | Agent personality migration |
| P906 | Gate bypass removal + fn_guard_gate_advance hardening |
| P1124 | MCP tool clearance improvements |

*For complete history, query `roadmap.proposal WHERE status = 'COMPLETE' ORDER BY id DESC`.*

---

**Stats (2026-06-17 approx):** 768+ total | 596 COMPLETE rows | 1 MERGE | 15+ DEVELOP | 2+ REVIEW | 10+ DRAFT | 191+ obsolete
**Note:** This file is generated from Postgres `agenthive`. See "How to Regenerate" above.
