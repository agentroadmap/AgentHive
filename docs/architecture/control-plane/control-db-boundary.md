# P430 — Control DB Boundary: Table Classification

> **Type:** component  **Parent:** P429  **MCP-tracked:** Yes  **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P430  
> **Status:** COMPLETE  **Documenter:** ccs46ant-bot-docum-a (2026-05-09); updated 2026-05-12 to classify P923/P993 tables

This document classifies every table in the current AgentHive schema as **control**, **project**, or **projection**, satisfying P430 Acceptance Criteria 1–5. The MCP/Postgres record for P430 is canonical; this file is the synced design output.

Companion docs:
- [`../control-plane-multi-project-architecture.md`](../control-plane-multi-project-architecture.md) — boundary rules, entity model, dispatch flow, migration phases, non-negotiable invariants
- [`../control-plane-ddl-sketch.md`](../control-plane-ddl-sketch.md) — schema-qualified DDL for the 10 target control schemas

---

## Classification Legend

| Tag | Meaning |
| --- | --- |
| **control** | Lives in `agenthive_control`. Shared platform/orchestration state with `project_id` for scoping. Never in a project database. |
| **project** | Lives in a per-project database. Project domain/runtime data only. No AgentHive orchestration records. |
| **projection** | Read-only cache or materialized view derived from an authoritative control-plane source. May exist locally for performance; source of truth remains in control. |

---

## Current Schema → Target Architecture Mapping

| Current schema | Target schema | Classification |
| --- | --- | --- |
| `roadmap` | `control_workflow`, `control_dispatch`, `control_audit`, `control_docs`, `control_identity`, `control_runtime` | control |
| `roadmap_proposal` | `control_workflow` | control |
| `roadmap_workforce` | `control_dispatch`, `control_workforce` | control |
| `roadmap_efficiency` | `control_budget` | control |
| `control_identity` | `control_identity` | control (already in target namespace) |
| `control_runtime` | `control_runtime` | control (already in target namespace) |
| `control_git` | `control_git` | control (already in target namespace) |
| `control_audit` | `control_audit` | control (already in target namespace) |
| `metrics` | `control_budget` | projection (rolled-up view of efficiency data) |
| `token_cache` | `control_budget` | projection (semantic cache; content lives in control, index is local) |
| `dependency` | `control_workflow` | control |
| `template` | `control_workflow` | control |
| `workflow_active` | `control_workflow` | control |
| `roadmap_messaging` | `control_dispatch` | control |
| *(project databases)* | per-project DB | project |

---

## `roadmap_proposal` Schema

All tables in this schema are **control-plane**. Proposals, workflow state, and lifecycle records are AgentHive orchestration data. They live in `agenthive_control.control_workflow` in the target architecture and are scoped to projects via `project_id`.

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `proposal` | control | `control_workflow` | Core proposal lifecycle. Contains `project_id`. Never moves to project DB. |
| `proposal_acceptance_criteria` | control | `control_workflow` | AC rows belong to a proposal. Must be visible to all evaluating agents across projects. |
| `proposal_decision` | control | `control_workflow` | Formal decisions against proposals. Audit trail. |
| `proposal_dependencies` | control | `control_workflow` | DAG of inter-proposal dependencies. Cross-project dependency graph via `dependency` schema. |
| `proposal_discussions` | control | `control_workflow` | Proposal-level discussion threads. Governance data. |
| `proposal_event` | control | `control_workflow` | Structured lifecycle events per proposal. Source for state-feed. |
| `proposal_labels` | control | `control_workflow` | Labels/tags on proposals. Control metadata. |
| `proposal_lease` | control | `control_dispatch` | Active agent leases on proposals. Enforced before claim. |
| `proposal_maturity_transitions` | control | `control_workflow` | Immutable maturity history. Audit trail. |
| `proposal_milestone` | control | `control_workflow` | Milestone markers on proposals. |
| `proposal_reviews` | control | `control_workflow` | Gate review records linked to proposals. |
| `proposal_state_transitions` | control | `control_workflow` | Immutable state-transition history. |
| `proposal_template` | control | `control_workflow` | Proposal creation templates. Platform config. |
| `proposal_type_config` | control | `control_workflow` | State machine configuration per proposal type. |
| `proposal_valid_transitions` | control | `control_workflow` | Allowed state transitions per type. State machine invariant. |
| `proposal_version` | control | `control_workflow` | Versioned snapshots of proposal content. |
| `proposal_versions` | control | `control_workflow` | Legacy version table (superseded by `proposal_version`; retained for compatibility). |
| `gate_decision_log` | control | `control_workflow` | Gate evaluator decisions. Contains `project_id` (added migration 066). Immutable audit. |
| `proposal_projection_cache` | projection | `control_workflow` | Materialized summary cache. Source of truth is `proposal` + related tables. |
| `post_gate_change_requirement` | control | `control_workflow` | Post-gate scope-change records. Governance. |

---

## `roadmap` Schema

The `roadmap` schema is the current monolith for shared platform state. In the target architecture it splits across `control_workflow`, `control_dispatch`, `control_audit`, `control_docs`, `control_identity`, and `control_runtime`.

### Workflow and State Machine

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `workflows` | control | `control_workflow` | Workflow instances tied to proposals. |
| `workflow_stages` | control | `control_workflow` | Stage definitions per workflow instance. |
| `workflow_transitions` | control | `control_workflow` | Allowed transitions per workflow. |
| `workflow_templates` | control | `control_workflow` | Reusable workflow templates. Platform config. |
| `workflow_roles` | control | `control_workflow` | Role definitions per workflow template. |
| `maturity` | control | `control_workflow` | Maturity classification config. |
| `gate_task_templates` | control | `control_workflow` | Gate task prompt templates per gate number. Platform config. |
| `transition_queue` | control | `control_dispatch` | Active gate/transition work items. Single-writer owned (P441). |
| `decision_queue` | control | `control_dispatch` | Legacy decision dispatch queue. Superseded by `transition_queue`. |

### Dispatch and Orchestration

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `project` | control | `control_project` | Project registry. Points to per-project databases. |
| `project_budget_cap` | control | `control_budget` | Per-project budget caps. Enforced before claim/spawn. |
| `project_capacity_config` | control | `control_dispatch` | Per-project concurrency and capacity policy. |
| `project_capability_scope` | control | `control_dispatch` | Project-scoped capability allowlists. |
| `project_route_allowlist` | control | `control_dispatch` | Allowed model routes per project. |
| `project_repair_queue` | control | `control_project` | Bootstrap repair queue for project DB provisioning. |
| `dispatch_route_audit` | control | `control_audit` | Audit log for route selection decisions. |
| `cli_builder_fallback_audit` | control | `control_audit` | Fallback routing audit for CLI builder. |
| `cubics` | control | `control_dispatch` | Cubic workspace registrations. Dispatched to agents. |
| `cubic_phase_roles` | control | `control_dispatch` | Phase/role config per cubic. |
| `resource_allocation` | control | `control_dispatch` | Resource reservation records. |
| `scheduled_job` | control | `control_dispatch` | Platform-level scheduled jobs. |
| `worktree_merge_log` | control | `control_git` | Merge operation audit log. |
| `worktree_pool` | control | `control_git` | Worktree pool inventory. |
| `schema_drift_seen` | control | `control_audit` | Schema-drift detection records. |
| `external_routing` | control | `control_dispatch` | External channel routing grants for agencies (Discord, etc.). Has `project_id`. Active-grant uniqueness enforced per channel_kind+external_id. Added P923. |
| `liaison_task_tracker` | control | `control_dispatch` | A2A liaison task state machine per proposal/dispatch. Typed task protocol tracking (pending→spawned→complete/failed). Added P993. |

### Models and Routes

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `model_routes` | control | `control_models` | Executable route policy objects. Source of truth for spawn. |
| `model_metadata` | control | `control_models` | Model capability metadata (context window, output limit). |
| `model_assignment` | control | `control_models` | Model assignments per agent/role. |
| `host_model_policy` | control | `control_models` | Host-level route provider allowlists. Enforced at spawn-time (P444). |
| `host_model_route_throttle` | control | `control_models` | Per-host per-route rate limit and throttle records. |
| `route_token_budget` | control | `control_budget` | Per-route token budget caps. |
| `route_decision_log` | control | `control_audit` | Immutable log of route selection decisions. |
| `agency_route_policy` | control | `control_models` | Agency-level route preference and restriction policy. |
| `agent_role_profile` | control | `control_workforce` | Role-specific model route profiles per agent type. |

### Identity and Sessions

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `user_session` | control | `control_identity` | Human user sessions. |
| `channel_identities` | control | `control_identity` | Cross-platform identity mappings (Discord, Slack, etc.). |
| `channel_subscription` | control | `control_identity` | Channel notification subscriptions. |
| `principal_identity` | control | `control_identity` | Unified principal records (human, service, agent). |
| `authority_grant` | control | `control_identity` | Delegated authority grants between principals. |
| `acl` | control | `control_identity` | Access control list entries. |
| `ui_preferences` | control | `control_identity` | Per-user UI preferences. |
| `principal_spending_cap` | control | `control_budget` | Per-principal spending caps. |
| `operator_principals` | control | `control_identity` | Operator principal whitelist for external routing grant/revoke authority. Added P923. |

### Documents and Knowledge

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `documents` | control | `control_docs` | Platform-level governance/architecture documents. |
| `document_versions` | control | `control_docs` | Document version history. |
| `attachment_registry` | control | `control_docs` | Attachment references for documents. |
| `knowledge_entries` | control | `control_docs` | Platform knowledge base entries. |
| `extracted_patterns` | control | `control_docs` | Patterns extracted from agent runs. Shared knowledge. |
| `research_cache` | projection | `control_docs` | Cached research results; source is external references + agent output. |
| `reference_terms` | control | `control_docs` | Domain terminology definitions. Platform config. |
| `embedding_index_registry` | control | `control_docs` | Registry of vector embedding indexes. |
| `prompt_template` | control | `control_docs` | Reusable prompt templates. Platform config. |
| `mcp_registry` | control | `control_runtime` | MCP server registrations and health. |
| `mcp_tool_registry` | control | `control_runtime` | MCP tool definitions. |
| `mcp_tool_assignment` | control | `control_runtime` | MCP tool assignments per project/agent. |

### Messaging and Notifications

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `notification` | control | `control_dispatch` | Platform notifications (state events, budget alerts). |
| `notification_delivery` | control | `control_dispatch` | Delivery records for notifications. |
| `notification_queue` | control | `control_dispatch` | Pending notification queue. |
| `notification_route` | control | `control_dispatch` | Notification routing rules. |
| `message_ledger` | control | `control_dispatch` | Agent-to-agent message ledger. |
| `message_timeout_tracking` | control | `control_dispatch` | A2A message timeout tracking. |
| `message_type_contract` | control | `control_dispatch` | Message type schema contracts. |
| `protocol_threads` | control | `control_dispatch` | Messaging protocol threads. |
| `protocol_replies` | control | `control_dispatch` | Replies within messaging threads. |
| `mentions` | control | `control_dispatch` | @-mention records in messages. |
| `webhook_subscription` | control | `control_dispatch` | Webhook endpoint subscriptions. |

### Audit and Governance

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `audit_log` | control | `control_audit` | Sensitive-table change audit log. Immutable. |
| `escalation_log` | control | `control_audit` | Escalation records for blocked proposals. |
| `run_log` | control | `control_audit` | Per-run execution records. Contains `project_id` (added migration 066). |
| `decision_explainability` | control | `control_audit` | Explainability records for dispatch decisions. |
| `agent_lifecycle_log` | control | `control_audit` | Agent lifecycle events (start, stop, error). |
| `liaison_poke_attempt` | control | `control_dispatch` | Liaison poke attempts to unblock proposals. |
| `external_routing_audit` | control | `control_audit` | Append-only audit log for external routing grant/revoke/deny operations. Added P923. |

### Observability

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `trace_span` | control | `control_audit` | Distributed trace spans. Platform observability. |
| `agent_execution_span` | control | `control_audit` | Agent-level execution spans. |
| `model_routing_outcome` | control | `control_audit` | Route selection outcomes for observability. |
| `proposal_lifecycle_event` | control | `control_audit` | Coarse lifecycle events per proposal (faster queries than full audit_log). |

### Tools

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `tool` | control | `control_runtime` | Tool catalog (MCP and native tools). |
| `tool_grant` | control | `control_runtime` | Tool access grants per agent/project. |
| `tool_invocation_log` | control | `control_audit` | Immutable log of tool invocations. |

### Program Structure

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `program_phases` | control | `control_workflow` | High-level program phase definitions. |
| `app_config` | control | `control_runtime` | Platform runtime configuration (key/value). |

---

## `roadmap_workforce` Schema

All tables in this schema are **control-plane**. Agency, worker, and dispatch records are orchestration data. They live in `control_dispatch` and `control_workforce` in the target architecture.

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `agent_registry` | control | `control_workforce` | Stable agency identities. Control-plane master record. |
| `agent_capability` | control | `control_workforce` | Per-agency capability declarations. Used in claim filtering. |
| `agency_profile` | control | `control_workforce` | Agency configuration and trust metadata. |
| `agent_conflicts` | control | `control_workforce` | Agency conflict declarations (mutual exclusion policy). |
| `agent_health` | control | `control_workforce` | Current health status per agency. |
| `agent_heartbeat_log` | control | `control_workforce` | Heartbeat history. Retention-bound log. |
| `agent_runs` | control | `control_audit` | Per-run records with full identity, route, spend, and context columns. Contains `project_id`. |
| `agent_workload` | control | `control_workforce` | Current workload counters per agency. |
| `squad_dispatch` | control | `control_dispatch` | Work offers and claims. Single source of truth for dispatch state. Contains `project_id`. |
| `team` | control | `control_workforce` | Logical teams grouping agencies. |
| `team_member` | control | `control_workforce` | Agency membership in teams. |
| `authority_chain` | control | `control_identity` | Principal authority chain records. |
| `agent_trust` | control | `control_identity` | Trust level records per agent. |
| `provider_registry` | control | `control_dispatch` | Agency-project subscriptions. FAIL-CLOSED: agency only claims projects it is registered for. |
| `transition_lease` | control | `control_dispatch` | Dispatch-level transition leases (P437 idempotency boundary). |
| `retry_policy` | control | `control_dispatch` | Per-dispatch retry configuration. |

---

## `roadmap_efficiency` Schema

All tables are **control-plane**. Spend, budget, and performance data must be globally visible.

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `spending_log` | control | `control_budget` | Per-invocation spend records. Contains `agent_identity` and `proposal_id`. |
| `spending_caps` | control | `control_budget` | Per-agent daily spend caps and freeze state. |
| `agent_budget_ledger` | control | `control_budget` | Running budget ledger per agent. |
| `budget_allowance` | control | `control_budget` | Budget allocation records per scope. |
| `budget_circuit_breaker` | control | `control_budget` | Circuit-breaker state for runaway spend. |
| `context_window_log` | control | `control_budget` | Per-invocation context window records. Contains `project_id` (added migration 066). |
| `cache_hit_log` | control | `control_budget` | Prompt cache hit records. |
| `cache_write_log` | control | `control_budget` | Prompt cache write records. |
| `api_buffer` | control | `control_dispatch` | Outbound API call buffer (retry-safe). |
| `agent_memory` | control | `control_docs` | Agent-scoped persistent memory entries. |
| `cost_ledger_summary` | projection | `control_budget` | Rollup summary; derived from `spending_log`. |
| `dispatch_metric_summary` | projection | `control_budget` | Rollup summary; derived from `squad_dispatch`. |
| `efficiency_metric` | projection | `control_budget` | Computed efficiency metrics; derived from multiple tables. |

---

## `metrics` Schema

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `token_efficiency` | projection | `control_budget` | Aggregated token efficiency view. Derived from `context_window_log` and `spending_log`. |

---

## `token_cache` Schema

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `semantic_responses` | projection | `control_budget` / local | Semantic response cache. Content semantically equivalent to prior invocations. Not authoritative; can be rebuilt. Potentially stays local to host. |

---

## `dependency` Schema

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `cross_project_dependency` | control | `control_workflow` | Cross-project dependency graph. Requires global visibility. |
| `dependency_kind_catalog` | control | `control_workflow` | Dependency type definitions. Platform config. |

---

## `template` / `workflow_active` Schemas

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `template.workflow_template` | control | `control_workflow` | Versioned workflow template definitions. |
| `template.template_backfill_orphans` | control | `control_workflow` | Orphan records during template migration. Temporary. |
| `workflow_active.workflow_template_copy` | projection | `control_workflow` | Active-copy of a workflow template for a running workflow instance. Source is `template.workflow_template`. |

---

## `roadmap_messaging` Schema

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `denied_messages` | control | `control_dispatch` | Records of denied inter-agent messages. Trust enforcement audit. |

---

## `control_identity` Schema (Target-Namespace Tables)

These tables already use the target schema namespace, having been introduced by P843/P844 migrations.

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `auth_decision_log` | control | `control_identity` | Immutable auth decision records. |
| `agent_project_roles` | control | `control_identity` | Agent role assignments per project. Used for pool identity gating. |
| `pool_access_audit` | control | `control_identity` | Pool access attempt audit. |

---

## `control_runtime` Schema (Target-Namespace Tables)

Introduced by P441 (migration 071) and P442 (migration 072).

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `service_registry` | control | `control_runtime` | Running service instances with heartbeat. |
| `service_responsibility` | control | `control_runtime` | Declared single-writer ownership per responsibility. |
| `service_lease` | control | `control_runtime` | Active write leases per responsibility (one active lease enforced). |
| `host_drain` | control | `control_runtime` | Host drain state (quiesce + terminate). |

---

## `control_git` Schema (Target-Namespace Tables)

Introduced by P444 (migration 066) and P444 run-record separation (migration 073).

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `worktree_policy` | control | `control_git` | Worktree access policy per agent/project. |
| `worktree_overrides` | control | `control_git` | Per-dispatch worktree policy overrides. |

---

## `control_audit` Schema (Target-Namespace Tables)

Introduced by P438 (migration 067) and P442 (migration 072).

| Table | Classification | Target schema | Rationale |
| --- | --- | --- | --- |
| `claim_rejection` | control | `control_audit` | Rejected claim attempt records. FAIL-CLOSED enforcement audit. |
| `operator_action_log` | control | `control_audit` | Operator-issued stop/cancel/drain/terminate commands. |

---

## Project Database Tables

Project databases contain **no AgentHive orchestration records**. They contain only project domain/runtime data: the application or product data the project itself is building, testing, or analyzing.

The AgentHive project database (`agenthive_project_main`) will contain application-level tables once the project database split (P432) is complete. Examples:

- Application feature tables (roadmap product domain data, not the control plane)
- Imported datasets, fixtures, generated test data
- Project-local vector/embedding stores
- Build artifacts and domain telemetry
- Sandboxes and project-local schemas

Until P432 is implemented, all data lives in the single current database. No migration should move proposal, workflow, dispatch, lease, review, discussion, budget, or run records to a project database.

---

## Compatibility Views

During the migration window (Phase 2 → Phase 3 in the multi-project architecture), the following compatibility views must be maintained in the old `roadmap` and `roadmap_*` schemas to avoid breaking running services:

| View | Source-of-truth location | Notes |
| --- | --- | --- |
| `roadmap.proposal` | `control_workflow.proposal` | Read-only compatibility alias |
| `roadmap.gate_decision_log` | `control_workflow.gate_decision_log` | Implements `project_id` column (added migration 066) |
| `roadmap.context_window_log` | `control_budget.context_window_log` | Exposes `project_id` column (added migration 066) |
| `roadmap.run_log` | `control_audit.run_log` | Scoped to project |
| `roadmap_workforce.squad_dispatch` | `control_dispatch.squad_dispatch` | Must preserve claim semantics |
| `roadmap_efficiency.spending_log` | `control_budget.spending_log` | Read-only alias |

Compatibility views are DROP-able only after all downstream consumers have migrated their connection strings and queries to the canonical `agenthive_control` database.

---

## Migration Order Constraints

Follow-on proposals must respect this dependency order:

```
P430 (this document — boundary classification)
  └── P431 (P436): Control database bootstrap + schema reconciliation
        └── P432: Project database isolation (PoolManager, per-project DSNs)
        └── P433 (P437): Dispatch idempotency + transition leases
              └── P438: Claim policy fail-closed
              └── P440: Dispatch retry and terminal semantics
        └── P434 (P444): Provider route + budget governance
        └── P441: Service topology ownership
              └── P435: Control panel observability
              └── P442: Operator stop controls
              └── P443: State feed causal IDs
```

No proposal may migrate tables classified as **control** into a project database. Any proposal that adds new tables must classify them in its design before merge.

---

## Acceptance Criteria Verification

| AC | Status | Evidence |
| --- | --- | --- |
| AC-1: Every existing table classified with rationale | ✅ | Tables above, organized by schema |
| AC-2: No new shared runtime state added to project databases | ✅ | All live tables classified as `control` or `projection`; project DB section defines the boundary explicitly |
| AC-3: Compatibility views designed for migration window | ✅ | Compatibility Views section above |
| AC-4: Architecture names the control schemas and project schemas | ✅ | Mapping table at top; each table shows target schema |
| AC-5: Follow-on migration proposals have explicit dependencies | ✅ | Migration Order Constraints section above; each follow-on proposal listed |
