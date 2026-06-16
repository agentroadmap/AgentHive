# 🗺️ AgentHive Roadmap

> Generated: 2026-06-16 13:00 EDT | Source: Postgres `agenthive` | 760 total proposals (569 active, 191 obsolete)

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

| State | Count | Notes |
|-------|-------|-------|
| ✅ COMPLETE | 547 | 155 mature, 392 new |
| 🔀 MERGE | 1 | In integration |
| 🔨 DEVELOP | 7 | 4 mature (code-ready to gate), 3 new |
| 🔍 REVIEW | 1 | 1 mature (awaiting gate decision) |
| 📝 DRAFT | 13 | 2 active, 9 mature, 2 new |
| ⚪ Obsolete | 191 | Across all states — superseded or invalidated |
| **Total** | **760** | |

---

## 🔀 MERGE (1)

| ID | Title | Maturity |
|----|-------|---------|
| P1441 | V3-C9: Rollout step 1 — claude-gary-bot single agency, 1→N workers (e2e gate) | new |

---

## 🔨 DEVELOP (7 active)

| ID | Title | Maturity |
|----|-------|---------|
| P1391 | Lease lifecycle as TTL + first-class hold/reject verdict wiring | mature |
| P3535 | Decouple maturity lifecycle from lease occupancy — monotonic progress + lease-based exclusive claim | mature |
| P3566 | Gate-advance authorization integrity (non-terminal gates): independent reviewer, blocking-review respected, no review-only bypass | mature |
| P477 | Web control-plane redesign for multi-project AgentHive operations | mature |
| P1024 | Pillar 8: Web and Operator Experience — Dashboard, Operator CLI, TUI Board, Activity Feed, Discord Bridge | new |
| P1442 | V3-C10: Rollout steps 2-4 — multi-agency, multi-OS-user, multi-host | new |
| P2326 | Ad-hoc A2A task bucket (sentinel proposal for no-proposal task_requests) | new |

---

## 🔍 REVIEW (1 active)

| ID | Title | Maturity |
|----|-------|---------|
| P3564 | Board pg pool doesn't survive a Postgres restart — route queries via pgbouncer + auto-heal pool | mature |

---

## 📝 DRAFT (13 active)

| ID | Title | Maturity |
|----|-------|---------|
| P3563 | Acceptance loop must have ground truth: independent, evidenced, non-vacuous AC verification as a hard gate invariant | mature |
| P3565 | Intake triage + risk-tiering: proposals opt-IN to autonomy, high-blast-radius work requires human approval | mature |
| P3781 | Configuration Management: categorize runtime_flag, web config UI, and hardcoded-constant migration | mature |
| P3782 | Config taxonomy: add category to runtime_flag schema + ConfigKey registry + set() schema reconciliation, backfill existing keys | mature |
| P3784 | Config introspection API: list all config keys with category, value, default, scope, editability | mature |
| P3785 | Web config interface: category-grouped browse + audited inline edit in dashboard | mature |
| P3787 | Hardcoded-constant migration: inventory + move high-value core/infra literals into categorized runtime flags | mature |
| P3793 | Codebase Gap Analysis: architecture, implementation, operational, and governance gaps | mature |
| P3794 | CI: SIGTERM regression test suite for long-running services | new |
| P3795 | Hard routing gate on provider health — block dispatch to unhealthy providers | new |
| P3796 | Monolith decomposition plan: roadmap.ts (6191 lines) and server/index.ts (6761 lines) | new |
| P3797 | Wire agenthive-scan-* rule packs as required CI gates in .gitlab-ci.yml | new |
| P3798 | Docs update sweep: stale proposal references, V2 architecture, CLI migration | active |

---

## ✅ COMPLETE (547 active, 49 obsolete)

547 proposals are in COMPLETE state. Full listing is available via MCP or direct DB query:

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
| P3566 | Gate-advance authorization integrity (non-terminal gates) |
| P3508 | Multi-project access control — project-creation ACLs + token/route scoping |
| P3326 | gate_decision D2 advance target + prop_transition validator |
| P1107 | Wire AC-8 CI gates — mcp-bundle + message-drift + migration-continuity |
| P1071 | Close unclosed it() block in AC-4 self-parent test |
| P477 | Web control-plane redesign (partially — routing layer complete) |
| P3198 | SIGTERM clean-exit handler for long-running services |
| P2496 | Retract-on-terminal-state trigger |
| P1144 | Orchestrator dead-const cleanup |
| P893 | System-init deploy scripts |
| P3310 | Difficulty signal for adaptive work-model matching |
| P3311 | Beta-Bernoulli reliability ledger |
| P3312 | Unified matcher shadow-wiring |
| P3313 | Closed feedback loop for adaptive matching |
| P1376 | Agency-aware cooldown filter + throttle resolver |
| P1356 | Agent personality migration |
| P1375 | Workforce state machine visualization |
| P1352 | Multi-project cross-reference schema |
| P906 | Gate bypass removal + fn_guard_gate_advance hardening |
| P1124 | MCP tool clearance improvements |

*For complete history, query `roadmap.proposal WHERE status = 'COMPLETE' ORDER BY id DESC`.*

---

**Stats:** 760 total | 547 COMPLETE | 1 MERGE | 7 DEVELOP | 1 REVIEW | 13 DRAFT | 191 obsolete
**Note:** This file is generated from Postgres `agenthive`. See "How to Regenerate" above.
