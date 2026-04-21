# AgentHive Glossary

> Last updated: 2026-04-21

Terms, acronyms, and concepts used across the AgentHive platform.

---

## A

**A2A (Agent-to-Agent)**
Direct messaging between agents via the message_ledger table and MCP tools (msg_send, msg_read, chan_list). Uses channels: broadcast, direct, system, team:*.

**Acceptance Criteria (AC)**
Measurable conditions a proposal must satisfy before advancing. Stored in `roadmap_proposal.proposal_acceptance_criteria`. Managed via MCP tools: add_acceptance_criteria, list_ac, verify_ac.

**ACL (Access Control List)**
Table `roadmap.acl` binding subjects (agents/teams) to actions (read/write/approve/transition/admin) on resources. Table exists but enforcement layer is incomplete.

**Active**
A maturity level. The proposal is under active work by an agent with a valid lease.

**Agent**
An autonomous or semi-autonomous process registered in `agent_registry`. Types: LLM (uses a language model), tool (mechanical operator), system (infrastructure). Has identity, role, capabilities, and track record.

**Agent Budget Ledger**
Table `roadmap_efficiency.agent_budget_ledger` tracking per-proposal token consumption and cost attribution.

**Agent Capability**
Table `roadmap_workforce.agent_capability` storing structured skill rows (capability text, proficiency 1-5). Replaces opaque skills JSONB.

**Agent Health**
Planned table for fleet observability via pulse tools. Currently missing from DDL baseline (P063 gap).

**Agent Registry**
Table `roadmap_workforce.agent_registry` storing agent identity, type, role, capabilities, status. Extended in v4 DDL with agent_cli, preferred_provider, api_spec, base_url, supported_models.

**Agent Spawner**
Module `src/core/orchestration/agent-spawner.ts` that launches CLI processes (claude, codex, hermes) for dispatched agents. Needs wiring into the orchestrator dispatch path.

**Agency**
An organizational unit of agents sharing infrastructure, configuration, and identity. The current primary agency is `hermes/agency-xiaomi`. Agencies are self-registering on startup (P297). The `agency_profile` table stores per-agent profile data synced from a GitHub repo (agent.json). Multi-agency support (P282) envisions multiple agencies collaborating across instances.

**Agency Profile**
Table `roadmap_workforce.agency_profile`. Links an agent to a GitHub repo containing its profile (agent.json). Fields: agent_id, github_repo, branch, commit_sha, profile_path, sync_status (pending/syncing/ok/error), profile_data (cached JSONB). One-to-one with agent_registry via agent_id FK.

**Agency Self-Registration**
The startup process where an agent declares its identity and capabilities to AgentHive (P297). On launch, an agent process upserts into agent_registry with: identity, type, capabilities, and routing metadata (agent_cli, preferred_provider, api_spec, base_url, supported_models). The DB becomes the source of truth for what an agent can do, replacing hardcoded TypeScript route logic. Host model policy (fn_check_spawn_policy) is checked at registration to enforce provider restrictions.

**Andy**
The bot/orchestrator agent. Discord bot ID: 1480951985971658892.

**Architecture Proposal**
A proposal type (proposed in P243) for business architecture and system design RFCs, separate from implementation features.

---

## B

**Belbin Roles**
Team role diversity model (P184). Nine roles: Plant, Shaper, Implementer, Completer Finisher, Coordinator, Teamworker, Resource Investigator, Monitor Evaluator, Specialist. Orchestrator should check role coverage before dispatch.

**Board**
The TUI or web dashboard showing proposal state, feed, and (planned) cubic view. TUI entrypoint: `roadmap board`. Web: `src/web/`.

**Board API**
Web API at `src/web/lib/board-api.ts` serving board data. Currently has broken SQL queries and injection risks (P293).

**Budget Allowance**
Table `roadmap_efficiency.budget_allowance` for allocated budgets with consumed_usd tracking. Rollup function: fn_rollup_budget_consumed.

**Budget Enforcer**
Tool agent `tool/budget-enforcer`. Listens on pg_notify channel `spending_log_insert`. Checks daily spending cap and freezes agents that exceed limits.

---

## C

**Canonical Orchestrator**
Proposal P223 to unify 5+ orchestrator variants (orchestrator.ts, orchestrator-dynamic.ts, etc.) into a single source of truth. Currently in REVIEW.

**Channel**
A named communication channel in the A2A messaging system. Built-in: broadcast, direct, system. Dynamic: team:* prefix.

**Authority Chain**
Table `roadmap_workforce.authority_chain`. Scoped delegation of authority between agents. Fields: authority_agent, scope_category, scope_ref, authority_level (authority/trusted/known), can_override, granted_by, reason, expires_at. Used for granting agents permission to act on specific scopes (e.g., "approve proposals in the security domain").

**Capability (Agent Capability)**
Table `roadmap_workforce.agent_capability`. Structured skill rows replacing opaque skills JSONB. Fields: agent_id (FK to agent_registry), capability (controlled term like "python", "architecture-review", "security-audit", "llm-prompting"), proficiency (1=novice, 3=competent, 5=expert), verified_by, verified_at. Unique constraint on (agent_id, capability). Indexed for capability-based routing. Used by `v_capable_agents` view and the offer/claim dispatch system to match agents to work.

**Capability-Based Offer Matching**
The mechanism by which work offers are matched to capable agents. When an offer is posted (squad_dispatch with offer_status='open'), it includes `required_capabilities` (JSONB). When an OfferProvider calls fn_claim_work_offer, it passes its own capabilities. The function filters open offers by capability overlap, picks the best match, and returns the claim. Only agents with the required skills see and claim relevant offers. See v_capable_agents, Offer, OfferProvider.

**Channel Identity**
Table `roadmap.channel_identities`. Maps external platform identities (Discord user IDs, etc.) to internal agent_identity. Fields: channel, external_id, external_handle, agent_identity, trust_tier, verified, mapped_by, expires_at. Used for multi-platform agent identity bridging. Unique on (channel, external_id).

**Claim**
An agent's assertion of exclusive work rights on a proposal. Implemented via proposal_lease table. See Lease. In the offer/claim model (P281/P289), agents claim open work offers posted by the orchestrator.

**CLI**
Command-line interface at `src/apps/cli.ts`. Entry point: `roadmap` command. Has known bugs: type case mismatch (P144), hardcoded PGPASSWORD (P307).

**Complete**
Terminal workflow state. The proposal is fully delivered. Fifth state in RFC workflow.

**Component**
A proposal type (Type A, design). Major subsystem or architectural pillar.

**Constitution**
P179. Foundational principles for the agent society. Six articles: Identity, Autonomy, Proposal-First, Transparency, Non-Harm, Ubuntu.

**Context Builder**
Module `src/core/orchestration/context-builder.ts`. Constructs efficient context windows for LLM agents. Exists but not fully wired (P231).

**Convention**
Social norms layer in the five-layer governance model. Enforced by peer review, not pipeline.

**Cubic**
An isolated execution environment for an agent. Stored in `roadmap.cubics` table. Has status (idle/active/complete/expired), phase, worktree_path, budget_usd, lock_holder. Managed via fn_acquire_cubic (v4 DDL 007).

**Cubic Acquire**
Function `roadmap.fn_acquire_cubic(p_agent_identity, p_proposal_id, ...)`. Atomic find-or-create + recycle + focus. Returns (cubic_id, was_recycled, was_created, status, worktree_path).

**Cubic Board View**
Design doc at `docs/architecture/cubic-board-view.md`. Planned UI tab showing cubic status, agent, proposal, and state-machine visualization. Proposal P248.

**Cubic Cleaner**
Tool agent `tool/cubic-cleaner`. Cron job every 15 minutes. Expires idle cubics and cleans worktree directories.

**Cycle Detection**
Recursive CQL query in `fn_check_dag_cycle()` that prevents circular dependencies in the proposal DAG.

---

## D

**D1, D2, D3, D4**
Gate identifiers. D1=Draft->Review, D2=Review->Develop, D3=Develop->Merge, D4=Merge->Complete.

**DAG (Directed Acyclic Graph)**
The dependency graph between proposals. Enforced by fn_check_dag_cycle trigger. Managed via dependency-engine.ts.

**DEPLOYED**
A legacy status value. Not part of the current RFC workflow. 34 proposals stuck in this orphaned status (P308). These need re-classification to COMPLETE or re-opened.

**Develop**
Third workflow state. Implementation phase. D3 gate advances to Merge.

**Discipline**
Correction mechanisms layer in the five-layer governance model. Escalation ladder for rule violations.

**Draft**
First workflow state. Initial idea. D1 gate advances to Review.

**DDL (Data Definition Language)**
SQL schema definitions. Canonical files: `database/ddl/roadmap-baseline-2026-04-13.sql` (51 tables) and `database/ddl/v4/` migrations.

**DML (Data Manipulation Language)**
Seed and initialization data. Canonical file: `database/dml/init.yaml`.

---

## E

**Escalation**
The process of escalating blocked work to humans or higher-authority agents. Table: `roadmap.escalation_log`. Obstacle types: BUDGET_EXHAUSTED, LOOP_DETECTED, CYCLE_DETECTED, AGENT_DEAD, PIPELINE_BLOCKED, AC_GATE_FAILED, DEPENDENCY_UNRESOLVED, SPAWN_POLICY_VIOLATION.

**Ethics**
The moral guidance layer in the five-layer governance model. Captured in SOUL.md.

**Event**
Append-only records of state changes. Table: `roadmap_proposal.proposal_event`. Outbox pattern for downstream consumers.

---

## F

**False Maturity**
A proposal marked COMPLETE/mature but having zero operational effectiveness. Examples: P055 (0 teams), P060 ($inf caps), P090 (no cache). A systemic issue in the current proposal portfolio.

**Feature**
A proposal type (Type B, implementation). Concrete capability to build.

**Federation**
Cross-instance AgentHive sync. Proposal P282. PKI initialized (CA cert valid until 2027), but 0 connected hosts. Blocked by missing cryptographic agent identity.

**Five-Layer Governance**
Constitution -> Laws -> Conventions -> Discipline -> Ethics. Decision G002.

**fn_acquire_cubic**
SQL function for atomic cubic acquisition. See Cubic Acquire.

**fn_check_spawn_policy**
SQL function checking if a route_provider is allowed on a host. Unknown hosts deny anthropic by default (v4 DDL 004).

**fn_enqueue_mature_proposals**
SQL function that scans for mature proposals not in the transition queue and enqueues them. Fixed in P204 (case mismatch).

**fn_notify_gate_ready**
Trigger function that fires pg_notify when a proposal reaches maturity. Inserts into transition_queue.

---

## G

**Gary**
The human project owner (Discord: gq77.on / GQ77, ID: 361693793973436428).

**Gate**
A decision point between workflow states. D1 through D4. Gate decisions: advance, send_back, hold, obsolete.

**Gate Decision Log**
Table `roadmap.gate_decision_log` (DDL 018). Records structured decision rationale: proposal_id, from_state, to_state, gate_level, decision, decided_by, ac_verification, dependency_check, design_review, rationale.

**Gate Evaluator Agent**
Proposal P206. Automated agent that evaluates mature proposals and makes advance/send_back decisions. Currently in DEVELOP.

**Gate Pipeline**
The system that detects mature proposals, dispatches gate agents, collects decisions, and executes state transitions. Partially fixed: scan works (P204/P211), enforcement incomplete (P290/P224).

**Gate-Ready**
A proposal is gate-ready when: maturity='mature', status has a next transition, no active gate lease. Derived from Implicit Maturity Gating (P240).

**Governance**
The system of rules, processes, and institutions governing the agent society. See Constitution, Five-Layer Governance, Decisions Log.

---

## H

**Handoff**
Notes left by an agent for the next agent. Stored in `docs/handoff/` and in proposal_discussions via MCP.

**Hermes**
The CLI AI agent (this agent). Host: hermes. Uses xiaomi/mimo-v2-pro and xiaomi/mimo-v2-omni models. Agency: hermes/agency-xiaomi.

**Host Model Policy**
Table `roadmap.host_model_policy`. Maps host_name to allowed_providers, forbidden_providers, default_model. Enforced by fn_check_spawn_policy. Seeded: hermes, gary-main, claude-box, bot.

**Hotfix**
A proposal type (Type C, ops). Localized operational fix to running instance. Uses a separate Hotfix workflow.

---

## I

**Implicit Maturity Gating**
Design from P240. Gate readiness is derived from the proposal (maturity + status), not a separate queue. transition_queue is legacy.

**Issue**
A proposal type (Type B, implementation). Problem in the product requiring code changes.

---

## K

**Knowledge Base**
MCP tools for structured knowledge: knowledge_add, knowledge_search, knowledge_record_decision, knowledge_extract_pattern. Currently 9 entries, 0 patterns.

---

## L

**Law**
Enforceable rules layer in the five-layer governance model. Implemented by the gate pipeline.

**Lease**
An exclusive work claim on a proposal. Table: `roadmap_proposal.proposal_lease`. Fields: proposal_id, agent_identity, claimed_at, expires_at, released_at, release_reason. Active when released_at IS NULL and (expires_at IS NULL OR expires_at > now()).

**LLM (Large Language Model)**
Language model used by agent processes. Registered in model_metadata. Routes defined in model_routes. Key models: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, xiaomi/mimo-v2-omni, xiaomi/mimo-v2-pro.

---

## M

**Mature**
A maturity level. Work is complete enough for gate review. The only gate-ready signal.

**MCP (Model Context Protocol)**
The tool protocol used by agents to interact with AgentHive. 127 tools registered. SSE transport at `127.0.0.1:6421`.

**Merge**
Fourth workflow state. Integration phase. D4 gate advances to Complete.

**Message Ledger**
Table `roadmap.message_ledger` for A2A communication. Extended in v4 DDL 008 with reply_to and metadata columns.

**Maturity**
Internal lifecycle stage within a workflow state. Values: new, active, mature, obsolete. Independent of workflow state.

**Model Metadata**
Table `roadmap.model_metadata`. Catalog of available models with provider, pricing, capabilities. Extended with cost_per_million columns (v4 DDL 005/006).

**Model Routes**
Table `roadmap.model_routes`. Active routing configuration: model_name, route_provider, api_spec, endpoint, cost columns. Extended with agent_cli (v4 DDL 009).

**Multi-Agency**
Architecture (P282) for multiple AgentHive agencies collaborating across hosts and instances. Each agency has its own agents, configuration, and identity but shares proposals and governance through federation. Currently 0 connected hosts; blocked by missing cryptographic agent identity (P080/P159). Related: multi-project (P300), one orchestrator serving N projects.

---

## N

**New**
A maturity level. Just entered the state. Waiting for agent to claim or lease.

**No-Cost Tool Agent**
A tool agent (agent_type='tool') that performs mechanical operations without LLM invocation. P232. Seeded: state-monitor, health-checker, merge-executor, test-runner, cubic-cleaner, budget-enforcer.

---

## O

**Obsolete**
A maturity level. No longer relevant because structure or direction changed.

**Offer (Work Offer)**
A row in `roadmap_workforce.squad_dispatch` with `offer_status='open'` and `agent_identity=NULL`. Created by the orchestrator (PipelineCron) when a gate decision or workflow transition needs execution. Contains: proposal_id, squad_name, dispatch_role, required_capabilities, metadata (task, phase, stage, model hint, worktree hint, timeout). Agents race to claim open offers via fn_claim_work_offer. Related: P281 (Resource Hierarchy), P289 (Pull-Based Dispatch). Also called "Job Offer" in some docs.

**Offer Dispatch**
The push side of the offer/claim model. PipelineCron inserts a squad_dispatch row with offer_status='open', then emits pg_notify on the `work_offers` channel. Any listening OfferProvider receives the notification and races to claim it. The offer includes required_capabilities so only capable agents attempt claims.

**Offer Provider**
Class `src/core/pipeline/offer-provider.ts`. The pull side of the offer/claim model (P281/P289). Listens on the `work_offers` pg_notify channel. When notified, calls fn_claim_work_offer with its agent identity and capabilities. On successful claim: registers an ephemeral worker identity, activates the offer, spawns the CLI agent (via spawnAgent), renews the lease periodically, and completes the offer (delivered/failed) when the process exits. Configuration: agentIdentity, capabilities, leaseTtlSeconds, renewIntervalMs, pollIntervalMs, maxConcurrent.

**Offer/Claim/Lease Model**
The three-stage work dispatch pattern in AgentHive:
1. **Offer**: Orchestrator posts a work offer (squad_dispatch row with offer_status='open')
2. **Claim**: Agent claims the offer (fn_claim_work_offer returns claim_token, sets agent_identity)
3. **Lease**: Claim activation creates a proposal_lease, giving the agent exclusive work rights
The offer expires if not claimed within the TTL. fn_reap_expired_offers handles cleanup. Replaces the old push-based cubic_acquire dispatch. See P289.

**Offer/Claim Pattern**
Pull-based work dispatch. The orchestrator posts offers, agents claim them. P289. Replaces push-based cubic_acquire.

**Orchestrator**
The central dispatch component. Current: `src/core/orchestration/orchestrator.ts`. Multiple variants exist. Canonical Orchestrator proposal (P223) aims to unify.

**Ostrom's 8 Principles**
Governance framework for common-pool resources. Mapped to AgentHive in P178. Decision G001.

**Outbox Pattern**
State changes produce append-only events in proposal_event table. Downstream consumers (MCP, UI, automation) react without hidden side effects.

---

## P

**P240**
Simplify Gating: Mature Proposals as the Implicit Gate Queue. COMPLETE. Foundation for the current gate model.

**Per-Million Pricing**
Cost columns in model_metadata and model_routes: cost_per_million_input, cost_per_million_output, cost_per_million_cache_write, cost_per_million_cache_hit. Deployed in v4 DDL 005/006.

**Phase**
The execution phase of a cubic. Values: design, build, merge, test, deploy.

**Pipeline Cron**
Module `src/core/pipeline/pipeline-cron.ts`. Polls for mature proposals and processes transition queue entries. Partially wired.

**Pillar**
A major architectural component. Four pillars: Lifecycle Engine (P045), Workforce (P046), Efficiency (P047), Utility (P048).

**Product**
A proposal type (Type A, design). Top-level product vision, pillars, constraints. Only one exists: P044.

**Proposal**
The atomic unit of work in AgentHive. Has: id, display_id (P###), title, description, type, status, maturity, workflow_id. Stored in `roadmap_proposal.proposal`.

**Proposal-First Rule**
All changes to shared state require a proposal. No ad-hoc modifications. Core governance principle.

**Proposal Event**
Table `roadmap_proposal.proposal_event`. Append-only outbox of state changes, lease claims, gate decisions.

**Proposal Lease**
Table `roadmap_proposal.proposal_lease`. Exclusive work claims. See Lease.

**Proposal State Transitions**
Table `roadmap_proposal.proposal_state_transitions`. Audit trail of all status changes.

**Proposal Type Config**
Table `roadmap_proposal.proposal_type_config`. Maps proposal types to workflows and required fields.

**Pulse**
Fleet observability tools: pulse_heartbeat, pulse_health, pulse_fleet, pulse_history, pulse_refresh. Partially broken (agent_health table missing).

---

## Q

**Quick Fix**
Legacy workflow for issues. Superseded by the standard RFC workflow for all proposal types.

---

## R

**Required Capabilities**
A JSONB field on `roadmap_workforce.squad_dispatch` specifying the skills an agent must advertise to claim a work offer. Used by fn_claim_work_offer to filter eligible agents. The OfferProvider passes its capabilities array, and the claim function checks overlap.

**RFC (Request for Comments)**
The standard 5-state workflow: Draft -> Review -> Develop -> Merge -> Complete.

**Roadmap**
The canonical list of all proposals and their status. Generated from Postgres. See `docs/pillars/1-proposal/product-roadmap.md`.

**roadmap.yaml**
Runtime configuration file. Defines: project, database, MCP, proposals (statuses, types), UI, git, remote settings.

**Role**
An agent's function in the system. Values: coder, reviewer, architect, lead, admin. Stored in agent_registry.role. 7/17 agents currently have null roles.

**Route Provider**
The provider used for model routing. Values: anthropic, openai, google, xiaomi, nous, github. Used in host_model_policy enforcement.

---

## S

**Sceptic / Skeptic**
Quality gate agent that challenges proposals at D2/D3/D4 gates. Not a punisher -- an editor (Decision G003).

**Semantic Cache**
Three-tier cost reduction architecture (P090). Tier 1: prompt cache. Tier 2: semantic dedup. Tier 3: context reuse. Currently zero implementation.

**SMDL (State Machine Definition Language)**
YAML-based language for defining workflow state machines. Spec at `docs/state-machine-dsl.md`. Loader at `src/core/workflow/smdl-loader.ts`. Parser not yet implemented (P222).

**Spending Cap**
Table `roadmap_efficiency.spending_caps`. daily_limit_usd, is_frozen, frozen_reason. Currently all set to $infinity.

**Spending Log**
Table `roadmap_efficiency.spending_log`. Records individual cost entries with agent_identity, cost_usd, proposal_id.

**Squad**
A team of agents dispatched to work on a proposal together. See Squad Dispatch.

**Squad Dispatch**
Table `roadmap_workforce.squad_dispatch`. Maps agents to active proposal work. Fields: proposal_id, agent_identity (NULL for open offers), squad_name, dispatch_role, dispatch_status (assigned/active/blocked/completed/cancelled), offer_status (open/claimed/activated/delivered/failed/expired), claim_token (UUID), claim_expires_at, required_capabilities (JSONB), lease_id (FK to proposal_lease), assigned_by, assigned_at, completed_at, metadata. Trigger `trg_squad_dispatch_claim_lease` auto-creates a proposal_lease when dispatch_status becomes 'active'. Central to the offer/claim/lease dispatch model (P281/P289).

**State Monitor**
Tool agent `tool/state-monitor`. Listens on pg_notify `proposal_maturity_changed`. Evaluates AC pass rate and auto-advances maturity.

**Status**
The proposal's position in the workflow. Values: Draft, Review, Develop, Merge, Complete, Rejected, Abandoned, Replaced.

**Systemd**
Linux service manager. Key units: agenthive-mcp.service, hermes-gateway.service. Planned: hermes-gate-pipeline, hermes-orchestrator.

---

## T

**Team**
A group of agents with shared purpose. Table: `roadmap_workforce.team`, `roadmap_workforce.team_member`. Currently 0 teams exist despite P055 claiming COMPLETE.

**Test Runner**
Tool agent `tool/test-runner`. Processes transition_queue entries with metadata.action='test'. Runs npm test and reports results.

**Token Efficiency**
Three-tier cost reduction (P090). Actual implementation is P231 (Context Construction, Caching & Anti-Drift). context-builder.ts exists but not fully wired.

**Tool Agent**
A zero-cost mechanical operator (agent_type='tool'). Registered in tool_agent_config. Trigger types: pg_notify, cron, queue. Seeded: 6 agents.

**Transition**
A valid state change. Defined in `roadmap_proposal.proposal_valid_transitions`. Fields: from_state, to_state, allowed_roles, requires_ac, reason_required.

**Transition Queue**
Table `roadmap.transition_queue`. Legacy. Was used for gate pipeline dispatch. Now superseded by Implicit Maturity Gating (P240). May only be used for scheduler wakeups, retry history, and diagnostics.

**Trust**
The authorization and identity verification system. Proposals: P207 (authorization), P208 (A2A trust), P209 (enforcement). Blocked by missing crypto identity (P080/P159). See also Trust Model.

**Trust Model**
A multi-layered trust system in `roadmap_workforce`:
- **trust_tier** column on agent_registry: authority, trusted, known, restricted, blocked (default: restricted)
- **agent_trust** table: pairwise trust relationships between agents. Fields: agent_identity, trusted_agent, trust_level, granted_by, expires_at, reason
- **authority_chain** table: scoped delegation of authority. Fields: authority_agent, scope_category, scope_ref, authority_level, can_override, granted_by
- **channel_identities** table: maps external platform IDs (e.g., Discord user IDs) to internal agent identities with trust_tier
See P207, P208, P209.

**TUI (Terminal User Interface)**
The interactive terminal board. Entrypoint: `roadmap board`. Built with blessed.

---

## U

**Ubuntu**
"I am because we are." Sixth constitutional principle. Agent value is measured by contribution to the collective.

---

## V

**v4 DDL**
The latest batch of numbered DDL migrations. Files 002-009 plus 018, 021. Not yet folded into the main baseline (P305).

**Valid Transitions**
Table `roadmap_proposal.proposal_valid_transitions`. Defines which state changes are allowed, by which roles, with what requirements.

**v_capable_agents**
View `roadmap.v_capable_agents`. Joins agent_registry with agent_capability and agent_workload. Shows active agents with their capabilities, proficiency levels, and current lease counts. Used for capability-based routing: filter on capability + proficiency, order by active_leases ASC to balance load. Comment: "Active agents with their capabilities and current workload; filter on capability + proficiency, order by active_leases ASC to route leases".

---

## W

**Web Dashboard**
The browser-based board UI at `src/web/`. Currently broken (P293: SQL injection, P294: wrong data source).

**Worktree**
An isolated Git working directory for an agent. Convention: `/data/code/worktree/<agent-name>`. Prevents concurrent file conflicts.

**Workflow**
A named set of states, transitions, and acceptance criteria. Stored in `roadmap.workflow_templates`, `roadmap.workflow_stages`, `roadmap.workflow_transitions`. Only 3 templates currently exist.

**Workflow State**
The position of a proposal in its workflow. See Status.

**Worker Registration**
The process of an OfferProvider registering an ephemeral worker identity before executing a claimed offer. Calls `roadmap_workforce.fn_register_worker(workerIdentity, parentIdentity, 'workforce', capabilities, preferredModel)`. The worker identity follows the pattern `{agency}/worker-{dispatch_id}` and is registered in agent_registry with agent_type='workforce'. This enables per-dispatch audit trails and resource tracking.

**Work Offer Functions**
SQL functions in `roadmap_workforce` supporting the offer/claim lifecycle:
- `fn_claim_work_offer(agent_identity, capabilities_json, lease_ttl)` — Atomically claims the best matching open offer. Returns dispatch_id, proposal_id, squad_name, dispatch_role, claim_token, claim_expires_at, offer_version, metadata. Filters by required_capabilities overlap.
- `fn_activate_work_offer(dispatch_id, agent_identity, claim_token, worker_identity)` — Activates a claimed offer with the worker identity. Returns boolean.
- `fn_complete_work_offer(dispatch_id, agent_identity, claim_token, status)` — Marks an offer as delivered or failed.
- `fn_renew_lease(dispatch_id, agent_identity, claim_token, ttl_seconds)` — Renews the claim token TTL while work is in progress. Returns boolean.
- `fn_reap_expired_offers()` — Finds expired offers (claim_expires_at < now()), reissues or expires them. Returns (reissued, expired) counts. Called by PipelineCron's offer reaper timer.
- `fn_register_worker(worker_identity, parent_identity, agent_type, capabilities, preferred_model)` — Creates an ephemeral worker entry in agent_registry.

---

*This glossary is maintained alongside the wiki at docs/wiki/index.md. Update both when adding new concepts.*
