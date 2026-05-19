# P590 — hiveCentral Data-Model Overhaul Ship Report

**Proposal:** P590 — hiveCentral data-model overhaul (parent)  
**Date:** 2026-05-12  
**Status:** COMPLETE  
**Reference design:** `docs/multi-project-redesign.md` (v3, locked at 21ab0fa)

---

## Purpose

This document is the agent onboarding reference for the v3 multi-project data-model overhaul. It records what was built, how the 18 schema areas map to DDL files and child proposals, what post-ship audit work was required, and the authoritative rules every downstream agent must follow.

---

## 1. What Was Built

### Topology

AgentHive now runs a **two-tier database topology**:

```
hiveCentral (control plane)     — shared infrastructure: identity, agencies, models,
                                   credentials, workforce, templates, tooling, sandboxes,
                                   project registry, dependency graph, messaging bus,
                                   observability, governance, efficiency rollups

agenthive (tenant DB)           — AgentHive's own proposals; marked is_self_evo=true
monkeyKing-audio (tenant DB)    — project-scoped proposals + domain data
georgia-singer (tenant DB)      — (same pattern)
…
```

The single-DB model where control-plane state and project proposals shared the `agenthive` database has been retired. Proposals live in the tenant DB of the project they describe. The `is_self_evo` flag in `hiveCentral.project.project` is the only special treatment AgentHive receives — it triggers elevated gating (mandatory shadow-test before MERGE) and stricter sandbox profiles; it does not relocate data.

### The Boundary Rule

> *If a row identifies a project, it goes in that project's tenant DB. If it identifies the platform itself, it goes in `hiveCentral`.*

`project_id` in any `hiveCentral` table is a **pointer to a tenant DB** — never a row discriminator. `WHERE project_id = $1` filters appear only on `project.*`, `dependency.*`, and cross-project rollup tables. Cross-DB joins are forbidden; handlers that need both control-plane and tenant data issue two queries and join in application code.

---

## 2. Child Proposal Map

P590 coordinated 18 schema areas. Each maps to one or more DDL files under `database/ddl/hivecentral/`:

| Design label | Child proposal | DDL file(s) | Schema |
|---|---|---|---|
| P530.0 Control-plane DR | — (addressed in design §11.3) | — | RPO/RTO design-only |
| P530.1 core | P592 | `000-roles.sql`, `001-core.sql` | `core` |
| P530.2 identity | P593 | `002-identity.sql` | `identity` |
| P530.3 agency | P594 | `003-agency.sql` | `agency` |
| P530.4 model | P595 | `004-model.sql` | `model` |
| P530.5 credential | P596 | `005-credential.sql` | `credential` |
| P530.6 workforce | P597 | `006-workforce.sql` | `workforce` |
| P530.7 template | P598 | `007-template.sql` | `template` |
| P530.8 tooling | — | `008-tooling.sql` | `tooling` |
| P530.9 sandbox | — | `009-sandbox.sql` | `sandbox` |
| P530.10 tenant lifecycle | P601 | `010-project.sql`, `010b-project-ext.sql` | `project` |
| P530.11 dependency | P896 | `011-dependency.sql` | `dependency` |
| P530.12 messaging | — | `012-messaging.sql` | `messaging` |
| P530.13 observability | P604 / P892 | `013-observability.sql` | `observability` |
| P530.14 governance | — | `014-governance.sql` | `governance` |
| P530.15 efficiency | — | `015-efficiency.sql` | `efficiency` |
| P530.16 policy engine | — | (PolicyEvaluator seam — design §9.5) | — |
| P530.17 proposal tiering | P897 | `proposal.tier` column on tenant schemas | — |

---

## 3. Schema Reference

### Control-plane schemas in `hiveCentral`

| Schema | Key tables | Purpose |
|---|---|---|
| `core` | `installation`, `host`, `os_user`, `runtime_flag`, `service_heartbeat` | Singletons + host registry + NOTIFY-based feature flags |
| `identity` | `principal`, `principal_key`, `did_document`, `trust_grant`, `audit_action` | Who is who, signed by what |
| `agency` | `agency_provider`, `agency`, `agency_session`, `liaison_message` | Provider directory + session lifecycle + A2A catalog |
| `model` | `model`, `model_route`, `host_model_policy`, `model_capability` | One global routing table; projects never pick models directly |
| `credential` | `credential`, `credential_grant`, `credential_rotation_log`, `vault_provider` | API keys + signing keys; plaintext stays in vault |
| `workforce` | `agent`, `agent_role`, `agent_skill`, `agent_capability`, `agent_persona` | Cross-project agent profiles |
| `template` | `workflow_template`, `state_name`, `gate_definition`, `proposal_template` | Central catalog; v1 projects copy, cannot customize |
| `tooling` | `tool`, `mcp_tool`, `cli_tool`, `tool_grant` | Shared utilities + per-project grants |
| `sandbox` | `sandbox_definition`, `boundary_policy`, `egress_rule`, `mount_grant` | Reusable sandbox profiles + central security policy |
| `project` | `project`, `project_db`, `project_host`, `project_repo`, `project_worktree`, `project_member`, `project_budget_policy`, `project_skill_grant`, `project_route_grant`, `project_sandbox_grant` | Registry — DSN pointers, budget policy, skill/route/sandbox grants |
| `dependency` | `cross_project_dependency`, `dependency_kind_catalog` | Graph edges for cross-tenant proposal links; soft FKs (no cross-DB FK) |
| `messaging` | `a2a_topic`, `a2a_message`, `a2a_subscription`, `a2a_dlq`, `a2a_message_archive` | Single A2A bus across all projects; transport-adapter abstracted |
| `observability` | `trace_span`, `agent_execution_span`, `proposal_lifecycle_event`, `model_routing_outcome`, `decision_explainability` | First-class tracing bounded context (was buried in efficiency pre-v2) |
| `governance` | `decision_log` (hash-chained), `policy_version`, `compliance_check`, `event_log` | Tamper-evident audit chain; survives tenant DB deletion |
| `efficiency` | `efficiency_metric`, `cost_ledger_summary`, `dispatch_metric_summary` | Cross-project rollups; raw per-project data lives in tenant DBs |

### Tenant DB schemas (per project)

| Schema | Key tables | Purpose |
|---|---|---|
| `proposal` | `proposal`, `proposal_section`, `proposal_dependency`, `proposal_decision`, `proposal_review`, `proposal_artifact`, `proposal_lease`, `gate_decision` | The durable product |
| `cubic` | `cubic`, `cubic_state`, `cubic_artifact` | Project-scoped execution context |
| `dispatch` | `dispatch`, `work_offer`, `work_claim`, `briefing`, `assistance_request` | Project-local dispatch state |
| `efficiency` | `efficiency_event`, `cost_ledger`, `dispatch_metric` | Raw per-project metrics (rolled up to central) |
| `workflow_active` | `workflow_template_copy`, `workflow_state_assignment` | Read-only copy of the central template chosen at bootstrap |

---

## 4. Conventions All Agents Must Follow

### DB access
- Use `config.getProjectDb(slug)` to resolve a tenant DB connection (post-P474 pool registry). Never hard-code a DSN.
- Never add `WHERE project_id = $1` to a `hiveCentral` table unless that table is `project.*`, `dependency.*`, or a cross-project rollup.

### Roles
- Six service roles: `agenthive_admin`, `agenthive_orchestrator`, `agenthive_agency`, `agenthive_a2a`, `agenthive_observability`, `agenthive_repl`.
- Apply scripts require `agenthive_admin` (superuser context).
- Role bootstrap is `000-roles.sql` — run before all other DDL. Script is idempotent.

### Hygiene fields
Every `hiveCentral` catalog table carries exactly **seven** hygiene fields:
```
owner_did         TEXT         NOT NULL
lifecycle_status  TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked'))
deprecated_at     TIMESTAMPTZ
retire_after      TIMESTAMPTZ
notes             TEXT
created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
```
Domain-alias timestamps (e.g., `bootstrapped_at`, `registered_at`) are **supplementary** — they do not replace `created_at`/`updated_at`.

### Apply order
```
000-roles.sql          — superuser, postgres DB
001-core.sql           — hivecentral DB
002-identity.sql
003-agency.sql
004-model.sql
005-credential.sql
006-workforce.sql
007-template.sql
008-tooling.sql
009-sandbox.sql
010-project.sql
010b-project-ext.sql
011-dependency.sql
012-messaging.sql
013-observability.sql
014-governance.sql
015-efficiency.sql
```

All files are idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`). Re-running the full stack against an initialized DB is always safe.

### Minimum PostgreSQL version
PostgreSQL **14** — required for `CREATE OR REPLACE TRIGGER` used across all schema files.

---

## 5. Post-Ship Audit (G-Series, P891–P899)

After the initial schema DDL shipped, a nine-proposal audit pass (G1–G9) hardened the `agentHive2` unified DB:

| Proposal | Gap addressed |
|---|---|
| P891 — G1 | camelCase identifier folding: PostgreSQL silently lowercased identifiers; DDL normalized |
| P892 — G2 | Observability schema (P604) ported into agentHive2 control plane |
| P893 — G3 | Tenant lifecycle state machine (ported from P601) |
| P894 — G4 | Partition maintenance job for time-series tables |
| P895 — G5 | Backup harness + nightly verify cron |
| P896 — G6 | Cross-project dependency graph + consistency check |
| P897 — G7 | Budget unblock reserve (`ordinary_share` / `unblock_reserve_share` split on `spBudget`) + `proposal.tier` column (Class A/B/C — P530.17) |
| P898 — G8 | DLQ replay/inspect MCP actions for messaging |
| P899 — G9 | `kbEmbedding` IVFFlat index auto-creation in project-init |

These gaps were structural omissions discovered during the agentHive2 DDL activation audit, not design regressions. All nine are COMPLETE.

---

## 6. Key Architectural Decisions (from v3 review)

| # | Decision | Outcome |
|---|---|---|
| 1 | Budget-dependency deadlock prevention | `spBudget` split: 80% ordinary / 20% unblock reserve. Cross-tenant dependency-blocking dispatches draw from reserve only. Structural, not runtime heuristic. |
| 2 | Tenant Lifecycle Control (P530.10) | Full bounded context: DB creation, schema bootstrap, template seed, grants, secrets, observability registration, cloning, archival, retirement. |
| 3 | Control-plane DR | Explicit RPO/RTO targets (§11.3 of design). Failover model, active-lease handling, orphan-lease reconciliation after failover. |
| 4 | Policy engine seam | `PolicyEvaluator` port abstraction (v1 hard-coded; graduation path to OPA documented). All grants, budgets, gating, workload-id, and dependency rules flow through this seam. |
| 5 | Proposal tiering (P530.17) | Class A (architectural/governed), B (normal project), C (lightweight operational). Different gating rigor per class. `proposal.tier` column with `CHECK (tier IN ('A','B','C'))`, default `'B'`. |
| 6 | Self-evolution isolation | AgentHive's own proposals live in `agenthive.proposal.proposal` (a tenant DB). `is_self_evo=true` only changes orchestrator routing. No proposals in `hiveCentral`. |
| 7 | A2A transport abstraction | `MessageTransport` adapter port; v1 uses Postgres NOTIFY; future swap to NATS/Kafka is a config change. |
| 8 | Singleton process guard | Orchestrator is "implementation v0" single-process. `@singleton-fragile` CI lint rule marks any code that assumes singleton semantics. Clustering migration is a tracked work item. |

---

## 7. File Index

| File | Description |
|---|---|
| `database/ddl/hivecentral/000-roles.sql` | Service role bootstrap (superuser) |
| `database/ddl/hivecentral/001-core.sql` | Installation singleton, host, OS user, runtime flags, service heartbeat |
| `database/ddl/hivecentral/002-identity.sql` | Principals, DID documents, keys, trust grants, audit actions |
| `database/ddl/hivecentral/003-agency.sql` | Agency providers, sessions, liaison message catalog |
| `database/ddl/hivecentral/004-model.sql` | Models, routes, host policy, capabilities |
| `database/ddl/hivecentral/005-credential.sql` | Vault adapters, credentials, grants, rotation log |
| `database/ddl/hivecentral/006-workforce.sql` | Agents, skills, capabilities, project assignments |
| `database/ddl/hivecentral/007-template.sql` | Workflow templates, states, gate definitions (immutable, versioned) |
| `database/ddl/hivecentral/008-tooling.sql` | MCP tools, CLI tools, per-principal grants |
| `database/ddl/hivecentral/009-sandbox.sql` | Sandbox definitions, boundary policies, egress rules, mount grants |
| `database/ddl/hivecentral/010-project.sql` | Project catalog, tenant DB bindings, host/repo/worktree refs |
| `database/ddl/hivecentral/010b-project-ext.sql` | Budget policy, capacity config, route/skill/sandbox grants |
| `database/ddl/hivecentral/011-dependency.sql` | Cross-project dependency graph; pg_notify on resolution |
| `database/ddl/hivecentral/012-messaging.sql` | A2A topic bus, message log, subscriptions, DLQ, cold archive |
| `database/ddl/hivecentral/013-observability.sql` | Trace spans, execution spans, lifecycle events, routing outcomes |
| `database/ddl/hivecentral/014-governance.sql` | Hash-chained decision log, policy versions, compliance checks, event spine |
| `database/ddl/hivecentral/015-efficiency.sql` | Cost attribution, dispatch metrics, token budget tracking (rollup only) |
| `database/ddl/hivecentral/README.md` | Apply order, role grant matrix, hygiene field contract |

---

## 8. References

- P590 proposal — MCP id 590
- `docs/multi-project-redesign.md` — v3 design document (21ab0fa)
- `docs/multi-project-redesign-gemini-review.md` — v1 Gemini review
- `docs/multi-project-redesign-chatgpt-review-after-gemini.md` — v1 GPT review
- `docs/multi-project-redesign-gemini-review-v2.md` — v2 Gemini review
- `docs/multi-project-redesign-chatgpt-review-after-gemini-v2.md` — v2 GPT review
- P592 — core schema (was P530.1)
- P593 — identity schema (was P530.2)
- P594 — agency schema (was P530.3)
- P595 — model schema (was P530.4)
- P596 — credential schema (was P530.5)
- P597 — workforce schema (was P530.6)
- P598 — template schema (was P530.7)
- P601 — project/tenant lifecycle schema (was P530.10)
- P604/P892 — observability schema (was P530.13)
- P896 — cross-project dependency graph (was P530.11 + G6 audit)
- P897 — budget unblock reserve + proposal tiering (was P530.17 + G7 audit)
- CONVENTIONS.md §6.0 — DB topology canonical statement
