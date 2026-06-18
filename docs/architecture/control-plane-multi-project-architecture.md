# AgentHive Control Plane Multi-Project Architecture

## Status

Draft architecture. This document consolidates and supersedes the split assumptions in the P298 design notes (the earlier multi-project registry design is now obsolete; the active successor is P429/P483).

## Problem

AgentHive is now being used to build AgentHive. That creates a bootstrap problem: the same database currently stores platform control-plane state and project-scoped AgentHive development state.

For one project this is tolerable. For multiple projects, it creates bad coupling:

- service orchestration and model routing are mixed with project proposals
- agencies and workers can claim jobs outside their intended project
- budgets and credentials are hard to scope correctly
- TUI, web, mobile, and automation need global visibility but project data should remain isolated
- AgentHive development work can disturb the platform that runs it

The target architecture is one Postgres instance with a dedicated control database plus project databases. The control database owns shared platform state. Project databases own only project-domain state.

## Core Decision

Use a single Postgres instance with multiple databases:

```text
Postgres instance
  agenthive_control        shared platform/control-plane database
  agenthive_project_main   project database for AgentHive itself
  project_alpha            project database
  project_beta             project database
```

This is not one schema per project inside the same database. It is one operational Postgres instance with a dedicated control database and one database per project.

## Control Database Ownership

`agenthive_control` owns anything that must be visible across projects, hosts, repos, agencies, providers, and UI surfaces.

| Domain | Examples |
| --- | --- |
| Identity and users | human users, service users, API clients, sessions, channel identities |
| Hosts and services | host registry, systemd services, process health, service leases, service config |
| Projects | project registry, project database DSNs, git roots, repo bindings, enabled surfaces |
| Git and worktrees | repo registry, worktree roots, branch policy, merge queue metadata |
| Agencies and workers | agency registry, worker parentage, capabilities, trust, health, project subscriptions |
| AI providers and models | provider accounts, model catalog, model routes, host policy, toolsets, context limits |
| Credentials | encrypted API-key references, token-plan references, environment variable names, rotation metadata |
| Budgets and spend | global, project, agency, route, proposal, and run budget caps; spend ledger |
| Dispatch and leases | squad dispatch, work offers, claims, claim tokens, transition queue, proposal leases |
| Shared workflow | workflow definitions, state-machine templates, gates, shared acceptance-criteria schema |
| Shared documents | global docs, governance docs, architecture docs, operational runbooks |
| Control panels | dashboard data, TUI state, mobile control panel state, notification routing |
| Audit and governance | decisions, reviews, escalation log, policy violations, operator actions |

Control-plane tables should use explicit schemas, for example:

```text
control_identity
control_runtime
control_project
control_git
control_workforce
control_models
control_budget
control_dispatch
control_workflow
control_docs
control_audit
```

The existing `roadmap_workforce`, `roadmap`, and `roadmap_efficiency` tables should be split by ownership during migration, not merely renamed.

## Project Database Ownership

Project databases own only project domain/runtime data: the application or product data that the project itself is building, testing, importing, or analyzing.

Project databases do not own AgentHive orchestration records. Proposals, workflow state, acceptance criteria, dispatch, leases, reviews, budgets, and agent run records remain in the control database with a `project_id`. This avoids split-brain workflow state and keeps the operator UI usable even when a project database is down.

| Domain | Examples |
| --- | --- |
| Product domain tables | app/business data owned by that project |
| Project datasets | imported datasets, fixtures, generated test data |
| Project documents | non-control documents and artifacts owned by the project domain |
| Embeddings and retrieval stores | project-local vector/search indexes, if not shared |
| Build/test artifacts | generated reports, coverage, snapshots, domain telemetry |
| Sandboxes | project-local execution databases or schemas |

Project databases should not own:

- proposals or proposal versions
- acceptance criteria or verification records
- workflow state, state transitions, or maturity transitions
- proposal dependencies
- reviews, discussions, or gate decisions
- dispatch queues or proposal leases
- agent runs, token ledgers, or context-window ledgers
- model routes
- API keys
- agency registrations
- host policy
- global budgets
- system service state
- shared workflow definitions
- shared documents, governance docs, or control-panel state

They may contain local projections or cached labels for project-local display, but the lifecycle source of truth for AgentHive coordination remains the control database.

## Entity Model

### Projects

The control database owns `project`.

Required fields:

```text
project_id
slug
name
status
db_name
db_host
db_port
db_user_ref
git_repo_id
git_root
worktree_root
default_branch
discord_channel_id
created_at
updated_at
```

Every project database is registered here before the platform can dispatch work into it.

### Repositories

The control database owns `git_repo`.

Required fields:

```text
repo_id
provider
remote_url
local_root
default_branch
project_id nullable
status
```

A project can have multiple repos. A repo can be shared only if explicitly marked as shared and governed by policy.

### Hosts

The control database owns `host`.

Required fields:

```text
host_id
host_name
machine_label
status
allowed_route_providers
service_user
worktree_root
last_seen_at
```

Host policy is route-specific. A host is not a provider. A host may run Hermes, Codex, Claude, Copilot, or utility workers, but only if the selected route is allowed by `host_model_policy`.

### Agencies and Workers

The control database owns stable agencies and ephemeral workers.

```text
agency
  agency_id
  identity
  provider_family
  status
  host_affinity
  max_concurrent_claims
  default_worktree_policy

worker
  worker_id
  identity
  agency_id
  dispatch_id
  status
  started_at
  completed_at
```

Agencies are stable. Workers are per-dispatch execution identities. A feed line such as `worker-11099 (architect)@hermes-andy` should be read as one job run claimed by a stable agency, not as a newly configured agency.

### Provider Accounts, Models, and Routes

Separate model catalog from runnable routes.

```text
model_catalog
  model_name
  model_provider
  context_window
  output_limit
  capabilities
  objective_rating
  status

provider_account
  provider_account_id
  provider
  plan_type            token_plan | api_key_plan | subscription | local
  credential_ref
  base_url
  owner_scope          global | project | agency
  owner_id
  status

model_route
  route_id
  model_name
  route_provider
  provider_account_id
  agent_provider
  agent_cli
  cli_path
  api_spec
  base_url
  priority
  is_default
  is_enabled
  cost_per_million_input
  cost_per_million_output
  cache_pricing
  spawn_toolsets
  spawn_delegate
```

The route is the executable policy object. Provider and model alone are not enough.

### Budgets

Budget caps must be hierarchical and enforced before claim and before spawn.

Scopes:

```text
global
project
repo
agency
provider_account
model_route
proposal
dispatch
run
```

Budget checks must consider:

- daily, weekly, and monthly hard caps
- soft warnings
- per-run token caps
- context-window truncation policy
- provider cooldowns
- credit exhausted/rate-limit state

### Context

Context policy belongs in the control database because it determines how agents are packaged and how much budget is consumed.

```text
context_policy
  policy_id
  scope_type
  scope_id
  max_prompt_tokens
  max_history_tokens
  retrieval_policy
  summarization_policy
  attachment_policy
  truncation_behavior
```

Project databases store project facts and documents. The control database stores the policy for selecting, summarizing, and budgeting those facts.

## Dispatch Flow

1. A project proposal changes state or maturity in `agenthive_control`.
2. A control-plane event is emitted or polled with `project_id`.
3. The control plane maps the event to a workflow rule.
4. The control plane creates one `dispatch` or `work_offer` row.
5. Claim filtering checks project subscription, required capabilities, host policy, route policy, budget, and concurrency.
6. A stable agency claims the offer.
7. The agency registers a per-dispatch worker.
8. The spawner resolves the route and credentials from the control database.
9. The worker receives AgentHive proposal/workflow context from the control database, plus optional project-domain context from the project database.
10. Run, spend, context-window, and audit records are written to the control database.
11. AgentHive proposal changes are written back to the control database; project-domain changes are written to the project database only when the task requires it.

Dispatch deduplication is mandatory:

- one active dispatch per `(project_id, proposal_id, workflow_state, role)` unless explicitly configured for multiple agents
- one active claim per dispatch
- one worker per claim
- retries use the same dispatch row until terminal or reissued with a new version

## Control API Boundary

All runtime services should connect to the control database first. Project database access is obtained through a project registry lookup.

Recommended services:

| Service | Control DB | Project DB |
| --- | --- | --- |
| MCP server | reads policy, routes tools | executes project tools by project context |
| Orchestrator | owns proposal workflow, dispatch, transition flow | optional project-domain reads |
| OfferProvider | claims work, records runs | optional project-domain reads/writes through scoped calls |
| State feed | global operational feed | optional project-domain detail links |
| Web/TUI/mobile | global control panel | drill-down into project data |

## Migration Strategy

### Phase 1: Freeze the Boundary

- Stop adding new shared state to project schemas.
- Document each table as `control`, `project`, or `projection`.
- Add project_id to all proposal, workflow, dispatch, run, spend, context, and event records in the control database.
- Make feeds show agency, dispatch id, project id, proposal id, route, model, and budget scope.

### Phase 2: Create `agenthive_control`

- Create the control database in the same Postgres instance.
- Create schemas for identity, runtime, project, git, workforce, models, budget, dispatch, workflow, docs, audit.
- Migrate proposals, workflow state, model catalog, routes, host policy, agencies, provider registry, budgets, dispatches, leases, discussions, reviews, and run logs.
- Keep compatibility views in the old DB during transition.

### Phase 3: Split Project Databases

- Register AgentHive itself as `agenthive_project_main`.
- Move only project-domain/runtime tables into the project database.
- Keep proposals, workflows, dispatch, leases, reviews, discussions, and AgentHive documents in the control database.
- Add project-aware PoolManager and MCP context selection.

### Phase 4: Enforce Runtime Policy

- Claim-time enforcement: project subscription, capabilities, budget, host policy.
- Spawn-time enforcement: route, credentials, toolsets, context, delegation.
- Feed/report enforcement: no hidden agency/provider/model/auth-source fields.

### Phase 5: Multi-Project Operations

- Project creation and archival tools.
- Per-project repo/worktree provisioning.
- Per-project dashboards.
- Cross-project read-only portfolio views.
- No cross-project proposal dependencies until explicitly designed.

## Non-Negotiable Invariants

1. Control-plane state never lives only in a project database.
2. Project databases never store raw provider credentials.
3. Agencies are stable; workers are per-dispatch.
4. Every dispatch has `project_id`, `proposal_id`, `role`, `required_capabilities`, `route_policy`, and budget scope.
5. Every run records agency, worker, host, route, model, auth source class, token usage, budget scope, and context policy.
6. Host policy is checked before spawn.
7. Budget policy is checked before claim and before spawn.
8. Project data access always goes through project registry context.
9. Shared workflows are versioned in the control database.
10. Proposals, workflows, leases, dispatches, reviews, and run records are control-plane data.
11. UI feeds must expose enough fields to stop runaway agents without guessing.

## Proposal Breakdown

This architecture should be delivered as multiple proposals, not one large migration.

| Proposal | Type | Purpose |
| --- | --- | --- |
| P410 Control DB Boundary | component | Define control vs project table ownership and compatibility strategy |
| P411 Control Database Bootstrap | feature | Create `agenthive_control`, schemas, registry tables, and migration harness |
| P412 Project Domain Database Isolation | feature | Isolate project domain/runtime data in per-project databases and add PoolManager |
| P413 Dispatch and Agency Hardening | issue | Deduplicate offers, enforce agency subscriptions, and prevent claim storms |
| P414 Provider Route and Budget Governance | feature | Normalize provider accounts, routes, credentials, budgets, context policy |
| P415 Control Panel Observability | feature | Make web/TUI/mobile feeds show project, agency, dispatch, route, budget, stop controls |
| P416 Schema Reconciliation for Control Plane | issue | Resolve migration drift and classify proposal/workflow state as control-plane data |
| P417 Dispatch Idempotency and Transition Leases | issue | Make dispatch rows the idempotency boundary for state-machine work |
| P418 Claim Policy Must Fail Closed | issue | Reject claims when project scope, capabilities, route, host, or budget policy is missing |
| P419 State Machine Concurrency Ceilings | issue | Enforce hard active-claim and worker ceilings by scope |
| P420 Dispatch Retry and Terminal Semantics | issue | Prevent failed work from reissuing endlessly as new dispatches |
| P421 Service Topology Ownership | component | Define one state-machine owner per service responsibility |
| P422 Operator Stop and Cancel Controls | feature | Add DB-backed cancel, suspend, drain, and terminate operations |
| P423 State Feed Causal IDs | feature | Add causal identifiers and stop scopes to TUI/web/mobile events |
| P424 Host, Provider, and Route Separation | issue | Separate host, agency, provider account, model route, CLI, and worktree policy |
| P425 State Machine Race Integration Tests | feature | Cover duplicate polls, concurrent claims, retries, cancellation, and policy failures |
| P426 MCP Runtime Reliability | issue | Make MCP health, transport compatibility, and proposal-tool readiness observable |
| P427 Cubic Worktree Path Normalization | issue | Normalize cubic paths and repair legacy `/data/code/worktree-*` rows |

## Open Questions

- Should project databases use identical schema names to today for compatibility, or new names that make scope explicit?
- Should provider accounts be global by default, or should project-owned API keys become first-class in Phase 2?
- Should one OfferProvider process host multiple agencies, or should each agency be its own systemd service?
- What is the minimum stop API: cancel dispatch, suspend agency, kill process, or all three?
