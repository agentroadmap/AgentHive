# P590 — hiveCentral Data-Model Overhaul (Parent)

**Status:** COMPLETE  
**Priority:** Critical  
**Domain:** control-plane / architecture  
**Reference:** `docs/multi-project-redesign.md` (v3, locked at commit `21ab0fa`)

---

## Overview

P590 is the parent proposal for the v3 multi-project redesign. It does not ship code itself; it coordinates 18 child proposals (the P530 family) and gates the migration cutover that replaces AgentHive's single-database model with a clean two-tier topology.

**The problem it solves:** Before this work, AgentHive conflated control-plane state with project data in one database. Onboarding any project other than AgentHive itself (e.g. `monkeyKing-audio`, `georgia-singer`) was structurally impossible — all projects would have shared the `agenthive` DB and violated tenant isolation.

**The v3 solution:** Split the platform into:
- **`hiveCentral`** — the control-plane database. Shared infrastructure: identity, agencies, models, credentials, workforce, templates, tooling, sandboxes, project registry, cross-project dependencies, observability, governance. Zero proposal rows.
- **One tenant DB per project** — proposals live here, scoped to the product they describe. The `agenthive` DB is one of these tenants, marked `is_self_evo = true`.

---

## Architecture

### Topology

```
┌─────────────────────────────────────────────┐
│  MAIN HOST (control-plane node)             │
│  ┌────────────────────────────────────────┐ │
│  │  PostgreSQL Instance                   │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │  hiveCentral  (control DB)       │  │ │
│  │  │   identity / agency / model      │  │ │
│  │  │   credential / workforce         │  │ │
│  │  │   template / tooling / sandbox   │  │ │
│  │  │   project registry (DSN ptrs)    │  │ │
│  │  │   observability / governance     │  │ │
│  │  │   NO proposals — registry only   │  │ │
│  │  └──────────────────────────────────┘  │ │
│  │  ┌──────────────────────────────────┐  │ │
│  │  │  agenthive  (self-evo tenant)    │  │ │
│  │  │  monkeyKing-audio (tenant)       │  │ │
│  │  │  georgia-singer   (tenant)  …    │  │ │
│  │  └──────────────────────────────────┘  │ │
│  └────────────────────────────────────────┘ │
│  Central Orchestrator (1 process, v0)       │
└─────────────────────────────────────────────┘
              ▲   ▲   ▲
   ┌──────────┘   │   └──────────┐
   │              │              │
Claude Agency  Codex Agency  Copilot Agency  …
```

**The keystone invariant:** `project_id` in `hiveCentral` is always a *pointer to a tenant DB*, never a row discriminator. No `WHERE project_id = $1` filter appears on any `hiveCentral` table except `project.*`, `dependency.*`, and central rollup tables. Cross-DB joins are forbidden — handlers that need both control-plane and tenant data issue two queries and join in application code.

---

## What Lives Where

### `hiveCentral` schemas (control plane)

| Schema | Key tables | Why central |
|---|---|---|
| `core` | `host`, `os_user`, `runtime_flag` | Singletons and per-host state |
| `identity` | `principal`, `principal_key`, `did_document`, `trust_grant`, `audit_action` | Auth identity, signed keys, trust grants |
| `agency` | `agency_provider`, `agency`, `agency_session`, `liaison_message` | Provider directory + A2A protocol |
| `model` | `model`, `model_route`, `host_model_policy` | One global routing table; agencies bind models |
| `credential` | `credential`, `credential_grant`, `vault_provider` | API tokens, OAuth grants, signing keys (pointers to vault — no plaintext) |
| `workforce` | `agent`, `agent_skill`, `agent_capability`, `agent_persona` | Cross-project agent catalog; projects grant, never define |
| `template` | `workflow_template`, `state_name`, `gate_definition` | Immutable versioned workflow templates; projects pin to a specific version |
| `tooling` | `tool`, `mcp_tool`, `cli_tool`, `tool_grant` | Shared utilities (psql, gh, git, MCP); grants per project |
| `sandbox` | `sandbox_definition`, `boundary_policy`, `egress_rule`, `mount_grant` | Reusable sandbox profiles; central security policy |
| `project` | `project`, `project_db`, `project_host`, `project_repo`, `project_worktree`, `project_budget_policy`, `project_skill_grant` | Registry: DSN pointers, repo URLs, budget policy |
| `dependency` | `cross_project_dependency`, `dependency_kind_catalog` | Cross-tenant dependency graph (no cross-DB FK possible) |
| `observability` | `trace_span`, `agent_execution_span`, `proposal_lifecycle_event`, `decision_explainability` | First-class bounded context; debugging substrate |
| `messaging` | `a2a_topic`, `a2a_message`, `a2a_subscription`, `a2a_dlq` | One A2A bus across all projects; `MessageTransport` adapter abstraction |
| `governance` | `decision_log` (hash-chained), `policy_version`, `compliance_check`, `event_log` | Tamper-evident audit chain; survives tenant DB deletion |
| `efficiency` | `efficiency_metric`, `cost_ledger_summary` | Cross-project rollups only; raw metrics live in tenant DBs |

### Each tenant DB (per project)

| Schema | Key tables | Why tenant |
|---|---|---|
| `proposal` | `proposal`, `proposal_section`, `proposal_decision`, `proposal_review`, `proposal_artifact`, `proposal_lease`, `gate_decision` | Proposals are the durable product of the project |
| `cubic` | `cubic`, `cubic_state`, `cubic_artifact` | Project-scoped execution context |
| `dispatch` | `dispatch`, `work_offer`, `work_claim`, `briefing`, `assistance_request`, `budget_enforcement_state` | Project-local dispatch; budget enforcement hook |
| `efficiency` | `efficiency_event` (raw), `cost_ledger` (raw), `dispatch_metric` (raw) | Raw per-project metrics; rolled up hourly into `hiveCentral.efficiency.*` |
| `workflow_active` | `workflow_template_copy`, `workflow_state_assignment` | Pinned template snapshot; read-only in v1 |
| `<domain>` | project-chosen (e.g. `audio.*`, `song.*`) | Actual product data |

---

## Self-Evolution as a Tenant

AgentHive's own proposals live in the `agenthive` tenant DB, not in `hiveCentral`. The `agenthive` project is marked `project.is_self_evo = true` in the central registry. That flag changes orchestrator behavior in three ways only:

1. **Elevated gating** — mandatory shadow-test phase between DEVELOP and MERGE (change applied to a temporary `hiveCentral` copy; smoke-tests run against it).
2. **Stricter sandbox** — `sandbox/self-evo-restricted`: read-only on all tenant DBs, write-only to a feature branch in the agenthive worktree, tighter egress.
3. **Two-person review** — gate decision for any self-evo MERGE requires two distinct principals. Single-agent auto-merge is forbidden.

There is no `orchestration_self` schema, no god-mode code path. One orchestrator code path handles all projects.

---

## Key Architectural Decisions

### Proposal Tiers (P530.17)

Three tiers prevent proposal inflation:

| Tier | Name | Gating |
|---|---|---|
| A | Architectural / governed | Two-person review; full RFC; mandatory shadow-test for self-evo |
| B | Normal project (default) | One-person gate review; tests required |
| C | Lightweight operational | Auto-advance if tests pass + one peer ack; no multi-section RFC |

Tier promotion is one-way: a mis-classified Class C is demoted to DRAFT and reborn as Class A.

### Budget — Three Concerns, Three Homes

| Concern | Where | What |
|---|---|---|
| Budget *policy* | `hiveCentral.project.project_budget_policy` | Set by governance; immutable once a period starts |
| Spend *enforcement* | `<tenant>.dispatch.budget_enforcement_state` | Dispatch hook checks against central policy hard-cap |
| Portfolio *rollup* | `hiveCentral.efficiency.cost_ledger_summary` | Hourly aggregation from tenant raw ledgers |

**Dependency unblock reserve (80/20 split):** 80% of budget is available for ordinary dispatches; 20% is reserved exclusively for dispatches that satisfy an active `blocks`-kind cross-project dependency. Prevents cross-tenant deadlock structurally.

### Credentials — No Plaintext in DB

All credentials are vault-pointer rows in `credential.credential`. The actual value lives in an external vault (systemd credential, file vault, AWS Secrets Manager, or HashiCorp Vault). Agencies authenticate to the orchestrator via Ed25519 keypair, not bearer tokens. Third-party API tokens are pulled fresh per spawn.

### Workflow Templates — Immutable, Versioned

`template.workflow_template` rows are immutable once published. Edits create a new version. Projects pin to a specific `template_id` at bootstrap and cannot modify it. Upgrading a project's template requires a self-evo proposal.

### Observability — First-Class Bounded Context

`observability` is its own schema (not a sub-concern of `efficiency`). Span data uses OpenTelemetry semantics; future export to Jaeger/Tempo/Honeycomb is a config change. Retention: trace data 30 days hot, archived thereafter; lifecycle events kept indefinitely.

### Control-Plane DR (P530.0)

Explicit RPO/RTO targets with:
- Hot standby (physical streaming replication) on the same PG instance
- Active-lease handling during failover (orchestrator sees the standby and reconciles)
- Orphan-lease reconciliation pass: after failover, a reconciler sweeps leases and closes any whose `agent_run` is no longer alive

### Catalog Hygiene (Anti-Swamp)

Every central catalog table carries five lifecycle fields: `owner_did`, `lifecycle_status` (`active|deprecated|retired`), `deprecated_at`, `retire_after`, `notes`. Rows are never deleted, only retired. A quarterly catalog-hygiene job reports rows past `retire_after`.

### Continuous Shadow-Link Auditor (P530.11)

The cross-project dependency consistency check runs nightly by default. Once cross-project edges exceed 50, it upgrades to continuous mode (NOTIFY-driven on tenant proposal mutations) to keep detection latency bounded.

---

## Children and Wave Plan

### Children (P530.0 – P530.17)

| ID | Scope |
|---|---|
| P530.0 | Control-plane DR (RPO/RTO, hot standby, lease reconciliation) — Wave 1 prerequisite |
| P530.1 | `core` schema (`host`, `os_user`, `runtime_flag`) |
| P530.2 | `identity` schema (`principal`, `did`, `audit_action`) |
| P530.3 | `agency` schema (`provider`, `agency`, `session`, `liaison_message`) |
| P530.4 | `model` schema (`model`, `route`, `host_policy`) |
| P530.5 | `credential` schema (vault adapter + grants + rotation log) |
| P530.6 | `workforce` schema (`agent`, `skill`, `capability`) |
| P530.7 | `template` schema (immutable versioned workflow templates) |
| P530.8 | `tooling` schema (tool catalog + grants) |
| P530.9 | `sandbox` schema (definition, policy, mount grant) |
| P530.10 | Tenant Lifecycle Control (state machine, provisioning, lifecycle ops) |
| P530.11 | `dependency` schema (cross-project graph + continuous shadow-link auditor) |
| P530.12 | `messaging` schema (a2a + transport adapter + cold-tier archive) |
| P530.13 | `observability` schema (spans, lifecycle events, routing outcomes) |
| P530.14 | `governance` schema (hash-chained decision log + event spine) |
| P530.15 | `efficiency` schema (rollups; raw events live in tenants) |
| P530.16 | Policy engine seam (`PolicyEvaluator` + decision-trace wiring) |
| P530.17 | Proposal tiering (Class A/B/C, gating differences, mis-classification auditor) |

### Wave Plan

| Wave | Proposals | Goal |
|---|---|---|
| 1 | P501, P530.0 | Empty `hiveCentral` with v3 schemas + DR design in place |
| 2 | P502, P503 | Logical replication + read-shadow validation |
| 3 | P504, P505, P518 | Cutover orchestrator, MCP, agencies one-by-one |
| 4 | P506, P507, P508 | `agenthive` becomes a tenant; first non-agenthive tenant onboards |
| 5 | P513–P517 | Hardening: sandboxes, vault, federation |

---

## Acceptance Criteria

1. All 18 children (P530.0–P530.17) reach COMPLETE.
2. `hiveCentral` DB exists with v3 schema layout; `agenthive` DB has no `roadmap_*` schemas.
3. At least one non-agenthive tenant DB is provisioned and produces a completed proposal end-to-end.
4. DR drill (manual failover) executes within RTO; lease reconciliation pass leaves zero orphan leases.
5. Audit chain verifier passes on the full chain.

---

## Review History

This design went through two external reviewer cycles before being locked at v3:
- **Gemini v1 + v2 reviews** — raised concerns on DR model, shadow-link auditor frequency, audit-chain re-hash speed, and singleton process fragility.
- **GPT v1 + v2 reviews** — raised concerns on budget deadlock, tenant lifecycle completeness, policy engine extensibility, proposal inflation, and SPOF orchestrator.

All `must-have` items from both reviewers were promoted into the v3 architecture document (not deferred to implementation backlog). See companion docs in `docs/` for the full review transcripts.

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P530.0–P530.17 | Children; all must reach COMPLETE for P590 AC-1 |
| P501 | Wave 1 — empty `hiveCentral` bootstrap; P590 is blocked until P501 ships against v3 schema |
| P482–P485 | Multi-project bootstrap: M0 bridge for first non-agenthive tenant onboarding |
| P602 | Cross-project dependency schema (P530.11 precursor) |
| P661 | Stale squad dispatch reconciler — compatible with P530.0 lease reconciliation |
