# 🗺️ AgentHive Roadmap

> Generated: 2026-06-17 00:00 UTC | Source: Postgres `agenthive` | 768 proposals

## Summary

| Status | Count |
|--------|-------|
| ✅ COMPLETE | 600 |
| 🔨 DEVELOP | 92 |
| 🔍 REVIEW | 37 |
| 📝 DRAFT | 39 |
| **Total** | **768** |

---

## ✅ COMPLETE (600)

600 proposals have reached COMPLETE status. Recent completions include:

| ID | Title |
|----|-------|
| P3787 | Hardcoded-constant migration: inventory + move high-value core/infra literals into runtime flags |
| P3784 | Config introspection API: list all config keys with category, value, default, scope, editable |
| P3564 | Board pg pool doesn't survive a Postgres restart — route queries via pgbouncer + auto-heal |
| P3508 | P477-C: Multi-project access control — project-creation ACLs + token/route scoping |
| P3507 | P477-B: Control-plane portal shell + cross-project aggregation views |

> Full COMPLETE history available via: `psql $DATABASE_URL -c "SELECT display_id, title FROM roadmap.proposal WHERE status='COMPLETE' ORDER BY id DESC;"`

---

## 🔨 DEVELOP (92)

| ID | Title | AC |
|----|-------|----|
| P047 | Pillar 3: Efficiency, Context & Financial Governance | 0/15 |
| P048 | Pillar 4: Utility Layer — CLI, MCP Server & Federation | 0/27 |
| P068 | Federation & Cross-Instance Sync | 0/17 |
| P087 | Adopt renamed maturity and dependency columns in Postgres and MCP code | 0/36 |
| P145 | Remove duplicate src/postgres/proposal-storage-v2.ts shim | 11/11 |
| P147 | P087 missing AC; ~12 code files still reference old maturity naming | 1/1 |
| P223 | Canonical Orchestrator - unified queue scanner and liaison offer loop | 18/18 |
| P231 | Token Efficiency — Context Construction, Caching & Anti-Drift | 0/16 |
| P289 | Pull-Based Work Dispatch & Provider Registration — Agent-Native Job Intake | 7/7 |
| P294 | Web UI: unify data source on Postgres — remove filesystem Core dependency | 0/1 |
| P298 | Multi-provider orchestration: concurrent OfferProviders + provider_registry routing | 0/8 |
| P300 | Multi-project architecture: one orchestrator, N projects, shared infra | 8/11 |
| P302 | Multi-project architecture: one orchestrator, N projects, shared infra | 0/13 |
| P388 | Dashboard Architecture & Data Layer | 0/14 |
| P400 | Fix dependency_note column mismatch in proposal storage and MCP handlers | 11/12 |
| P401 | Remove dead projection code and fix remaining dependency_note references | 5/5 |
| P429 | hiveControl + per-project tenant DBs (two-tier topology) — keystone migration | 3/3 |
| P438 | Claim Policy Must Fail Closed: empty capabilities and missing scope reject the claim | 3/3 |
| P471 | Phased build-order and critical-path plan for AgentHive multi-tenancy program | 4/4 |
| P473 | Compatibility-first migration plan for control plane and liaison cutover | 0/7 |
| P477 | Web control-plane redesign for multi-project AgentHive operations | 12/13 |
| P482 | Multi-Project Bootstrap (M0) — minimum schema/MCP/worktree changes to onboard projects | 0/17 |
| P485 | Bridge Sunset — plan for project_id columns and mcp_ops set_project once P429/P482 land | 0/6 |
| P497 | Connection pool registry: getControlPool + getProjectDb with LRU + per-pool sizing | 0/16 |
| P498 | Extend P474 config resolver with tenant_dsn class + databases.control reader | 0/0 |
| P527 | Cubic Cleanup Automation — orphan detection and lifecycle enforcement | 0/0 |
| P591 | Control-plane disaster recovery design | 7/14 |
| P592 | core schema — host, os_user, runtime_flag | 23/23 |
| P593 | identity schema — principal, did, audit_action | 0/12 |
| P594 | agency schema — provider, agency, session, liaison_message | 19/19 |
| P595 | model schema — model, route, host_policy | 8/8 |
| P596 | credential schema — vault adapter, grants, rotation log | 0/13 |
| P598 | template schema — immutable versioned workflow templates | 0/12 |
| P599 | tooling schema — tool catalog and grants | 9/10 |
| P600 | sandbox schema — definition, policy, mount_grant | 0/12 |
| P601 | Tenant Lifecycle Control | 0/13 |
| P603 | messaging schema — a2a bus with transport adapter | 0/12 |
| P606 | efficiency schema — central rollups only | 8/11 |
| P607 | Policy engine seam — PolicyEvaluator port | 0/10 |
| P674 | Notification router — kind+payload contract decoupled from transport | 15/15 |
| P705 | Operator visibility surface for P674/P675/P689 outputs (web dashboard) | 38/52 |
| P706 | Unify state vocabulary across proposal workflows (RFC + Hotfix) | 11/51 |
| P723 | Gate-Agent AC Verification Reform — Mandatory Evidence Checks at D3 | 0/11 |
| P744 | Umbrella A — Centralized Orchestrator | 0/15 |
| P746 | Umbrella C — Agency Offline Detection + Auto-Recovery | 7/14 |
| P747 | Umbrella D — Model Routing Restriction | 10/15 |
| P781 | P706-C0: shrink hot-path proposal functions to wake-up notifications and invariants | 10/13 |
| P904 | P902-B: Liaison-first dispatch (replace direct spawn with offer_dispatch) | 0/4 |
| P908 | P902-D: Legacy parity ports (enhancer-revise, provider cooldown, hold feedback) | 0/7 |
| P917 | P912 AC-6 follow-up: MCP agency lifecycle actions (agency_bootstrap / join_project) | 0/7 |
| P926 | Execution Plan: Architectural Consolidation & Cleanup | 13/14 |
| P1013 | agentHive2 Grand Picture — Product Vision, Operating Model, and System Boundaries | 8/20 |
| P1015 | Pillar 2: Proposal Engine — Lifecycle, Criteria, Leases, Mapping, and Documentation | 0/8 |
| P1016 | Pillar 3: Workforce and Agencies — Agent Registry, Self-Registration, Liaison Bots | 0/13 |
| P1017 | Pillar 4: Unified Messaging Infrastructure — Single Bus, Decoupled Presence, USE | 21/34 |
| P1024 | Pillar 8: Web and Operator Experience — Dashboard, Operator CLI, TUI Board | 5/9 |
| P1050 | Agency Presence State System — Liveness-Driven online/busy/away/offline with Trust | 0/15 |
| P1091 | Tiered Agent/Model Routing — formalize tier semantics + tier-aware resolver | 19/27 |
| P1112 | Agent Response Verification & Semantic Hygiene | 0/8 |
| P1136 | Multi-agency job-offer/claim system — orchestrator becomes pure matchmaker | 0/20 |
| P1361 | P1143-A Phase 1: per-agency standing liaison processes + OS-user auth binding | 3/6 |
| P1362 | P1143-B Phase 2: gate dispatch NOTIFY reconciler + weighted route selection | 0/10 |
| P1370 | Liaison runtime context: provider constraints + token budget + coordinator knowledge | 8/24 |
| P1372 | MCP register_agency action: canonical roadmap.agency insert path | 8/9 |
| P1391 | Lease lifecycle as TTL + first-class hold/reject verdict wiring | 13/50 |
| P1442 | V3-C10: Rollout steps 2-4 — multi-agency, multi-OS-user, multi-host | 1/6 |
| P1454 | Wire State Machine Race Guards (P445) | 0/2 |
| P2326 | Ad-hoc A2A task bucket (sentinel proposal for no-proposal task_requests) | 11/11 |
| P3535 | Decouple maturity lifecycle from lease occupancy — monotonic progress + lease-based | 11/11 |
| P3566 | Gate-advance authorization integrity (non-terminal gates): independent reviewer | 5/8 |
| P3781 | Configuration Management: categorize runtime_flag, web config UI, and hardcoded-constant migration | 2/14 |
| P3785 | Web config interface: category-grouped browse + audited inline edit in dashboard | 12/12 |
| P3793 | Codebase Gap Analysis: architecture, implementation, operational, and governance | 4/5 |
| P3794 | CI: SIGTERM regression test suite for long-running services | 5/5 |
| P3796 | Monolith decomposition plan: roadmap.ts (6191 lines) and server/index.ts (6761 lines) | 15/40 |
| P3797 | Wire agenthive-scan-* rule packs as required CI gates in .gitlab-ci.yml | 5/5 |
| P3798 | Docs update sweep: stale proposal references, V2 architecture, CLI migration | 3/3 |
| P3840 | Unified orchestrator job-posting pool — post offers for every non-terminal proposal | 8/8 |
| P611-test-1781500395276-19g24 | P611-test-idempotent *(test fixture)* | 0/0 |
| P611-test-1781500395415-kvbz3 | P611-test-noadvance *(test fixture)* | 0/0 |
| P3571 | p3566-test *(test fixture)* | 0/0 |
| P3573 | p3566-test *(test fixture)* | 0/0 |
| P3574 | p3566-test *(test fixture)* | 0/0 |
| P3580 | p3566-test *(test fixture)* | 0/0 |
| P3582 | p3566-test *(test fixture)* | 0/0 |
| P3583 | p3566-test *(test fixture)* | 0/0 |
| P3589 | p3566-test *(test fixture)* | 0/0 |
| P3591 | p3566-test *(test fixture)* | 0/0 |
| P3592 | p3566-test *(test fixture)* | 0/0 |
| P3630 | p3566-test *(test fixture)* | 0/0 |
| P3632 | p3566-test *(test fixture)* | 0/0 |
| P3633 | p3566-test *(test fixture)* | 0/0 |

---

## 🔍 REVIEW (37)

| ID | Title | AC |
|----|-------|----|
| P925 | P919-A: Operator rename CLI for permanent agent display aliases | 3/14 |
| P1108 | Wire verifyDeliverySignature into inbound HTTP callback handlers | 0/27 |
| P1121 | P1107 child: forensic snapshot table + read-flow cutover stamp | 0/10 |
| P1373 | P1365-A: Wire capacity filter into agency-resolver (AC-4 follow-up) | 0/7 |
| P2725 | record_gate_decision writes to_state=from_state — fn_guard_gate_advance gate_decision | 0/5 |
| P2918 | Schema-drift hotfix: message_id referenced after drop in P469 | 0/0 |
| P3795 | Hard routing gate on provider health — block dispatch to unhealthy providers | 0/7 |
| P3326-test-1781477801617-7c1z | P3326 test *(test fixture)* | 0/5 |
| P3326-test-1781477801642-jd6z | P3326 test *(test fixture)* | 0/0 |
| P3326-test-1781479423493-40os | P3326 test *(test fixture)* | 0/5 |
| P3326-test-1781479423518-dlmb | P3326 test *(test fixture)* | 0/0 |
| P3326-test-1781482085581-pkul | P3326 test *(test fixture)* | 0/0 |
| P3326-test-1781482085611-lw8s | P3326 test *(test fixture)* | 0/0 |
| P611-test-1781500395357-tfgvw | P611-test-drift *(test fixture)* | 0/0 |
| P3566-test-1781589710465-wv7ss | AC-4 late-blocking TOCTOU test *(test fixture)* | 0/0 |
| P3567 | p3566-test *(test fixture)* | 0/0 |
| P3568 | p3566-test *(test fixture)* | 0/0 |
| P3569 | p3566-test *(test fixture)* | 0/0 |
| P3570 | p3566-test *(test fixture)* | 0/0 |
| P3572 | p3566-test *(test fixture)* | 0/0 |
| P3575 | p3566-test *(test fixture)* | 0/0 |
| P3576 | p3566-test *(test fixture)* | 0/0 |
| P3577 | p3566-test *(test fixture)* | 0/0 |
| P3578 | p3566-test *(test fixture)* | 0/0 |
| P3579 | p3566-test *(test fixture)* | 0/0 |
| P3581 | p3566-test *(test fixture)* | 0/0 |
| P3584 | p3566-test *(test fixture)* | 0/0 |
| P3585 | p3566-test *(test fixture)* | 0/0 |
| P3586 | p3566-test *(test fixture)* | 0/0 |
| P3587 | p3566-test *(test fixture)* | 0/0 |
| P3588 | p3566-test *(test fixture)* | 0/0 |
| P3590 | p3566-test *(test fixture)* | 0/0 |
| P3626 | p3566-test *(test fixture)* | 0/5 |
| P3627 | p3566-test *(test fixture)* | 0/0 |
| P3628 | p3566-test *(test fixture)* | 0/0 |
| P3629 | p3566-test *(test fixture)* | 0/0 |
| P3631 | p3566-test *(test fixture)* | 0/0 |

---

## 📝 DRAFT (39)

| ID | Title | AC |
|----|-------|----|
| P184 | Belbin/team-role coverage as queue-role composition policy | 1/13 |
| P227 | Workflow quality checks as queue roles, not extra hardcoded workflow stages | 0/9 |
| P253 | Reap stale gary-owned gate-pipeline process before andy unit starts | 0/0 |
| P278 | Duplicate systemd units — gate-pipeline and mcp active in both system and user space | 0/0 |
| P288 | Fix detectProvider — worktreeName argument ignored, leaks forbidden providers | 0/0 |
| P820 | Clean-sheet hiveCentral vNext control-plane data model | 0/0 |
| P856 | Probe agent liveness via A2A protocol_ping when claim shows active but worker MIA | 5/8 |
| P910 | HOTFIX: fn_claim_work_offer chokes on object-form required_capabilities | 0/0 |
| P911 | Codex agency: start-codex-agency.ts + service unit | 0/0 |
| P916 | P912 deployment hygiene: restart copilot-agency, fix CHECK constraint violation | 7/9 |
| P927 | Gemini agency runtime: shim + systemd unit + CliInvocationHandler registration | 9/10 |
| P1002 | P1000-A: MCP proposal child-tree and parent-filter projection support | 0/10 |
| P1021 | Pillar 5: Execution and Orchestration — Orchestrator, Dispatch Loop, Work-Offer | 0/10 |
| P1022 | Pillar 6: Governance and Trust — Identity, Budget Wiring, Marketplace Admission | 0/21 |
| P1106 | P1017-E: Phase E — dispatcher service stable + HMAC verifier + DLQ + cross-host | 3/15 |
| P1111 | Fix Global AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE Default | 0/0 |
| P1122 | P1106 child: extend timeout-cron to DLQ-enqueue on terminal failure | 0/8 |
| P1125 | Single agenthive-agency.service — one supervisor, all agencies in-process | 0/0 |
| P1127 | P1107 child: agency liaison fallback handler — mark read_at on every received message | 0/14 |
| P1133 | V2 Long-Term: efficient cross-agency orchestration today → multi-project utility | 0/0 |
| P1353 | P1350-C: Capability self-declaration at agency register-time | 0/0 |
| P1378 | Sub-agent worktree contamination detector: pre/post HEAD snapshot + auto-revert | 0/0 |
| P1390 | Distinguish capacity-saturation from dispatch-loop in postWorkOffer circuit breaker | 0/6 |
| P1412 | Verify agency spawn-provider matches claimed provider — close the lying-registry | 0/5 |
| P1446 | Collapse per-agency NOTIFY channels to shared host/provider listeners | 0/6 |
| P1455 | Agent Source-Control Canon (GIT.md) foundational mandates | 4/4 |
| P1790 | Gate loop: held/unresolvable proposals re-gate forever (no decision recorded) | 0/0 |
| P3563 | Acceptance loop must have ground truth: independent, evidenced, non-vacuous AC verification | 12/12 |
| P3565 | Intake triage + risk-tiering: proposals opt-IN to autonomy, high-blast-radius workflow | 2/17 |
| P3782 | Config taxonomy: add category to runtime_flag schema + ConfigKey registry + set() | 0/10 |
| P3839 | Gating-as-a-job: mature proposals must post a claimable gate-decision job at every stage | 0/7 |
| P3841 | Enforce revised P996 agent naming — clean-slate re-registration + validator | 0/7 |
| P3842 | SIGTERM regression CI test suite for long-running services | 0/0 |
| P3843 | Provider health hard-routing gate: block dispatch to unhealthy providers | 0/0 |
| P3844 | Monolith decomposition plan: roadmap.ts (6 191 lines) and server/index.ts (6 761 lines) | 3/4 |
| P3845 | Scanner rule packs as mandatory CI gates in .gitlab-ci.yml | 0/0 |
| P3846 | Documentation update sweep: fix stale proposal references, V2 arch gaps, and CLI migration | 4/4 |
| P3566-test-1781589710105-xpiqc | AC-1 self-approve block test *(test fixture)* | 0/5 |
| P3566-test-1781589710228-x1bw9 | AC-2 blocking newer than approve *(test fixture)* | 0/9 |

---

## How to Regenerate

```sql
-- Run against the agenthive database (pgbouncer port 6432 or direct port 5432)
-- Header counts
SELECT status, COUNT(*) FROM roadmap.proposal GROUP BY status ORDER BY status;
SELECT COUNT(*) FROM roadmap.proposal;

-- Per-status listing with AC pass/total
SELECT
  COALESCE(display_id, 'P' || id) AS pid,
  title,
  status,
  (SELECT COUNT(*) FROM roadmap.proposal_acceptance_criteria ac
   WHERE ac.proposal_id = p.id AND ac.status = 'pass') AS passing,
  (SELECT COUNT(*) FROM roadmap.proposal_acceptance_criteria ac
   WHERE ac.proposal_id = p.id) AS total_ac
FROM roadmap.proposal p
ORDER BY status, id;
```

```bash
# Quick CLI regeneration (requires psql in PATH and DB env vars set):
export PGHOST=127.0.0.1 PGPORT=6432 PGDATABASE=agenthive PGUSER=admin
psql -t -A -F'|' -c "SELECT COALESCE(display_id,'P'||id),title,status FROM roadmap.proposal ORDER BY status,id;" \
  | awk -F'|' '{printf "| %-30s | %-80s | %s |\n", $1, $2, $3}'
```
