# 🗺️ AgentHive Roadmap

> Generated: 2026-06-16 | Source: Postgres `agenthive` | 569 proposals (non-obsolete)

## How to Regenerate

```sql
-- Run against agenthive DB (port 5432 direct or 6432 via pgbouncer)
SELECT p.display_id, p.title, p.status,
  COUNT(ac.id) FILTER (WHERE ac.status = 'pass') AS pass_ac,
  COUNT(ac.id) AS total_ac
FROM roadmap.proposal p
LEFT JOIN roadmap.proposal_acceptance_criteria ac ON ac.proposal_id = p.id
WHERE p.maturity != 'obsolete'
GROUP BY p.id, p.display_id, p.title, p.status
ORDER BY
  CASE p.status WHEN 'COMPLETE' THEN 1 WHEN 'MERGE' THEN 2 WHEN 'DEVELOP' THEN 3 WHEN 'REVIEW' THEN 4 WHEN 'DRAFT' THEN 5 ELSE 6 END,
  CASE WHEN p.display_id ~ '^P[0-9]+$' THEN CAST(SUBSTRING(p.display_id FROM 2) AS INTEGER) ELSE 9999 END,
  p.display_id;
```

---

## ✅ COMPLETE (544)

| ID | Title | AC |
|----|-------|----|
| P044 | agentRoadmap — Autonomous AI Agent-Native Product Development Platform | 0/17 |
| P045 | Pillar 1: Universal Proposal Lifecycle Engine | 19/23 |
| P046 | Pillar 2: Workforce Management & Agent Governance | 33/33 |
| P049 | State Machine & Workflow Engine | 11/11 |
| P050 | DAG Dependency Engine | 0/8 |
| P051 | Autonomous Pipeline — Test Discovery, Execution & Issue Tracking | 0/8 |
| P052 | Acceptance Criteria System | 11/11 |
| P053 | Proposal Storage, Audit Trail & Version Ledger | 11/11 |
| P054 | Agent Identity & Registry | 0/8 |
| P055 | Team & Squad Composition | 0/8 |
| P056 | Lease & Claim Protocol | 0/8 |
| P057 | Zero-Trust ACL & Security | 0/8 |
| P058 | Cubic Orchestration & Multi-LLM Routing | 0/8 |
| P059 | Model Registry & Cost-Aware Routing | 0/8 |
| P060 | Financial Governance & Circuit Breaker | 0/8 |
| P061 | Knowledge Base & Vector Search | 0/8 |
| P062 | Team Memory System | 0/8 |
| P063 | Pulse, Statistics & Fleet Observability | 0/8 |
| P064 | OpenClaw CLI | 0/8 |
| P065 | MCP Server & Tool Surface | 0/8 |
| P066 | Web Dashboard & TUI Board | 17/17 |
| P067 | Document, Note & Messaging System | 0/18 |
| P069 | roadmap board hangs indefinitely on "Loading roadmap data from Postgres..." | 0/0 |
| P070 | pool.ts ignores .env.agent — board hangs silently in worktree context | 5/5 |
| P071 | Migrations 007 & 008 grant public schema — all agents denied on roadmap schema | 0/0 |
| P072 | fn_set_updated_at trigger fails on proposal_type_config (column is modified_at) | 3/3 |
| P073 | No seed data for model_metadata — multi-LLM router blind at startup | 4/4 |
| P074 | workflow_load_builtin populates workflow_stages but prop_transition reads proposal_valid_transitions — all transitions blocked | 0/0 |
| P075 | agent_register MCP tool crashes on comma-separated skills — missing ::jsonb cast | 3/3 |
| P076 | transitionProposal() FK violation when transitioned_by agent not yet registered | 0/0 |
| P077 | proposal.maturity never updated on status transitions — always shows {"Draft":"New"} | 0/0 |
| P078 | Directive Lifecycle & Escalation Management | 0/12 |
| P079 | Federation sync conflicts with cross-branch DAG proposal resolution in src/core/dag/cross-branch-proposals.ts | 0/8 |
| P080 | P044 gap: No cryptographic agent identity — string-handle impersonation risk in federated deployments | 22/22 |
| P081 | P044 gap: No SLA or availability contract defined for the platform | 23/24 |
| P082 | DAG cycle detected: P048→P045 dependency path already exists | 0/5 |
| P086 | Rename proposal.maturity_state and dependency in live Postgres schema | 0/0 |
| P089 | Review the schema and define early cross-domain data architecture improvements | 6/6 |
| P090 | Token Efficiency — Three-Tier Cost Reduction Architecture | 1/5 |
| P091 | P068 naming discrepancy: MCP lists as Web Dashboard but roadmap shows as Risk Alert & Mitigation | 0/0 |
| P143 | CLI help text lists wrong proposal types and maturity values | 6/6 |
| P144 | CLI proposal create fails: type case mismatch between CLI and DB | 2/5 |
| P146 | Fix conflicting SQL migration file numbering | 0/0 |
| P148 | Auto-merge worktree changes to main and sync back to agents | 5/5 |
| P149 | Channel subscription and push notifications for MCP messaging | 647/647 |
| P150 | prop_update bypasses Decision Gate — no D1 gate decision recorded when transitioning DRAFT → REVIEW | 5/5 |
| P153 | Issue proposals created in RFC workflow (Draft) instead of Quick Fix (TRIAGE) | 0/0 |
| P154 | roadmap board TUI hangs after loading Postgres data | 0/3 |
| P155 | roadmap overview is reading the wrong database or schema | 0/0 |
| P156 | add_acceptance_criteria splits text into individual characters instead of storing as single AC | 8/8 |
| P157 | verify_ac returns 'undefined' values instead of AC details | 8/8 |
| P158 | list_ac returns 600+ items when add_acceptance_criteria splits by character | 4/4 |
| P159 | agent-identity.ts not wired to agent_registry — public_key columns exist but are never populated | 10/10 |
| P160 | CORRECTED: 2 dead files in dashboard-web — SearchResultsPage + Settings.tsx | 0/1 |
| P161 | Duplicate scripts in worktree — seed-proposals, cli, ws-bridge variants | 0/0 |
| P162 | CLI proposal list should group by proposal type then show states in natural workflow order | 0/701 |
| P163 | Effective blocking protocol — mature proposals don't block downstream work | 733/733 |
| P164 | Briefing assembler — complete context in one query before LLM decisions | 826/826 |
| P165 | Cycle resolution protocol — smart weakest-link breaking for circular DAG dependencies | 516/516 |
| P166 | Terminal state protocol — unified final state semantics across all workflow templates | 7/7 |
| P168 | Skeptic gate decisions fail to record — column 'actor' missing from audit_log table | 10/10 |
| P173 | Workforce Capacity Planning & Demand Forecasting | 6/6 |
| P174 | Agent Skill Certification & Reputation Ledger | 6/6 |
| P176 | Agent Labor Market & Talent Exchange Protocol | 6/6 |
| P178 | Ostrom's 8 Principles — mapped to AgentHive governance | 1/3 |
| P179 | AgentHive Constitution v1 — Foundational principles for agent society | 3/3 |
| P180 | Governance Implementation Roadmap — from research to running system | 0/3 |
| P181 | Agent governance: no formal amendment process for constitutional changes | 19/19 |
| P182 | Agent governance: no team-level governance layer — only individual and society | 9/9 |
| P183 | Agent onboarding document — read this before your first lease | 0/3 |
| P185 | Governance memory — decisions and rationale preserved across sessions | 3/3 |
| P186 | discord-bridge.ts destroyed by commit 73a505c — replaced full implementation with template | 0/0 |
| P187 | Reference Catalog System — unified controlled vocabulary for all proposals, workflow states, and domain values | 8/8 |
| P188 | Directive Proposal Type — human-issued commands with elevated priority and conflict detection | 17/18 |
| P189 | P090 semantic cache table exists but no code populates or reads it — zero cache hits | 0/0 |
| P191 | Daily Efficiency Views and Combined Metrics Dashboard | 8/8 |
| P192 | AC corruption bug: multi-character criteria split into individual characters | 0/0 |
| P193 | Cubic Lifecycle Management — concurrency limits, automatic cleanup, and recycling | 0/8 |
| P194 | Project and agent memory from queue, liaison, and transition events | 8/8 |
| P195 | Enhanced Token Tracking with Per-Proposal Accounting and Budget Circuit Breaker | 0/8 |
| P196 | Cubic lifecycle management via liaison/dispatch lifecycle events | 8/8 |
| P199 | Secure A2A Communication Model — Typed Payloads, Access Control & Targeted Delivery | 4/4 |
| P200 | Orchestrator dispatch fails on cubic_list error — infinite retry loop | 4/4 |
| P201 | roadmap.cubics table does not exist — all cubic MCP tools fail | 7/7 |
| P205 | Fix prop_create SQL bug — window functions not allowed in FILTER clause | 9/9 |
| P206 | Gate Evaluator Agent — Automated Mature→Advance Transitions | 1/11 |
| P208 | Agent Trust & Authorization Model for A2A Communication | 8/8 |
| P209 | Trust Enforcement: Agent Lifecycle Integration & System Guard | 0/8 |
| P210 | Crash Recovery & Automatic Handover Protocol | 9/16 |
| P221 | Discord Bridge — A2A Integration & Production Service | 10/10 |
| P222 | SMDL workflow registry - queue definitions, transitions, and gate role policy | 18/33 |
| P224 | State transitions require active lease to prevent duplicate gating | 0/0 |
| P225 | Tool agents: autonomous mechanical workers with LLM escalation | 0/9 |
| P226 | Tiered model routing with frontier oversight via queue-role policy | 6/10 |
| P228 | Cubic Runtime Abstraction — multi-CLI, host auth, cross-host A2A | 15/15 |
| P229 | Multi-Platform Subscription Registry & Model Catalog | 0/21 |
| P230 | Layered Memory System — Task, Project, Team, Society, Individual | 13/16 |
| P232 | No-Cost Mechanical Tool Agent Framework | 7/7 |
| P233 | Discord Bridge — Bidirectional CLI↔Gary Communication | 7/7 |
| P234 | A2A Execution Gating for Claude Token Safety | 10/10 |
| P235 | Platform-Aware Model Constraints — prevent cross-platform model leakage | 6/6 |
| P236 | Quality Control Guidelines and Background E2E Gating | 6/6 |
| P237 | Proposal Operating System — State Machine, Orchestrator, Gate Agents, and Cubic Dispatch | 7/10 |
| P238 | State Machine Dashboard - unified queue, dispatch, lease, and route visibility | 17/17 |
| P240 | Simplify Gating: Mature Proposals as the Implicit Gate Queue | 7/9 |
| P241 | Optional Standby Gating Mode for Builder-Gate Collaboration | 8/8 |
| P242 | Complete Mature Re-Evaluation Loop for Optimization and Transformation | 11/11 |
| P243 | Architecture Proposal Type and Business Architecture RFC Workflow | 11/11 |
| P244 | Collapse transition_queue — implement Implicit Maturity Gating per P240 | 0/0 |
| P245 | Hermes host spawn policy — forbid Anthropic models on non-Claude hosts | 0/0 |
| P246 | Per-million pricing + cache read/write cost columns in model_metadata and model_routes | 0/7 |
| P247 | TUI board: W and TAB workflow/view switch not firing — duplicate key registration | 0/0 |
| P248 | Board workflow visualization from SMDL queues and transition audit | 10/10 |
| P249 | Actual-cost tracking + model_* table consolidation | 3/9 |
| P250 | Roadmap board live feed should be chronological and keep the side panel readable | 0/0 |
| P251 | Liaison liveness - heartbeat, poke/pong, capacity, and dormancy signals | 10/10 |
| P254 | Add TimeoutStopSec to agenthive service units | 0/0 |
| P266 | Track in-flight dispatches in orchestrator shutdown path | 0/0 |
| P267 | Add SIGTERM drain to a2a-dispatcher | 0/0 |
| P268 | AbortController plumbing for in-flight MCP cubic_focus and cubic_create | 3/3 |
| P271 | Extend v_capable_agents to expose current_proposal, current_cubic, active_model | 0/0 |
| P272 | Create v_proposal_activity unified projection for board feed | 0/5 |
| P273 | Multi-assignment tracking for agents on multiple proposals | 0/0 |
| P274 | Agent scorer must pre-filter by host_model_policy before picking candidates | 0/0 |
| P276 | Proposal Detail Timeline and Canonical Export | 0/6 |
| P277 | Vertically Stacked All-Workflows Board View | 4/4 |
| P282 | Agent Communication Protocol — Bidirectional Agent-Orchestrator Dialogue | 0/10 |
| P285 | Dependency integrity guard for proposal obsolescence | 0/0 |
| P286 | Resource hierarchy: Branch → Worktree → Cubic → Agent | 8/9 |
| P287 | Federation: multi-product, multi-host, multi-agency AgentHive | 0/0 |
| P290 | Gate enforcement: status advancement requires gate_decision_log entry | 0/0 |
| P291 | D1 gate (Draft→Review) dispatches skeptic agent, not generic reviewer | 0/4 |
| P293 | Web UI board-api.ts: broken SQL queries, injection, missing statuses | 0/0 |
| P295 | Web UI: dispatch/offer/claim visibility — P281/P289 dashboard | 7/7 |
| P296 | Web UI: model routing management page | 7/7 |
| P299 | Orchestrator migration - retire direct spawn paths under unified queue scanner | 21/24 |
| P301 | Web UI: unify data source on Postgres — remove filesystem Core dependency | 9/9 |
| P303 | LLM-free mechanical status reporting and delivery pipeline | 12/12 |
| P304 | Platform messaging gateway as transport wake-up adapter, not scheduler | 7/11 |
| P305 | DDL baseline does not match live schema — new agents get wrong assumptions | 6/6 |
| P307 | CLI state-machine commands use hardcoded PGPASSWORD=*** literal | 11/11 |
| P308 | 34 proposals stuck in orphaned DEPLOYED status — not in any workflow | 0/12 |
| P371 | fn_sync_proposal_maturity resets COMPLETE proposals to 'mature', causing pg_notify gate-loop noise | 0/0 |
| P372 | Stale squad_dispatch rows block orchestrator re-dispatch — no TTL-based cleanup | 0/0 |
| P373 | proposal_valid_transitions empty while workflow_transitions populated — MCP vs DB transition validation split-brain | 3/3 |
| P374 | SMDL Review: expressiveness, efficiency, comparative analysis, visualization, and expansion | 5/6 |
| P375 | Suppress gate-ready notifications and freeze maturity for terminal workflow states | 4/4 |
| P377 | Sync proposal_valid_transitions from workflow_transitions — single source of truth | 3/3 |
| P378 | P175 marked COMPLETE but implementation is ~5% — AC verification gap | 6/6 |
| P380 | MCP RFC tools fail with type errors: add_discussion and list_ac reject valid proposal IDs | 3/3 |
| P381 | fn_sync_proposal_maturity unconditionally resets terminal state maturity to new | 0/10 |
| P383 | Spin detection: auto-hold proposals with repeated failures | 0/9 |
| P386 | Single-call prop_get_detail returning all child entities | 0/0 |
| P387 | Universal Web Dashboard — Multi-Project, Multi-Host, Multi-Agency Configuration Interface | 3/3 |
| P389 | Information Architecture & Navigation | 10/10 |
| P390 | Design System & Component Library | 18/18 |
| P391 | Project & Host Management UI | 3/9 |
| P392 | Agency & Workforce Configuration | 0/3 |
| P393 | Model Routes & LLM Configuration | 3/3 |
| P394 | Proposal Management & Kanban | 3/3 |
| P395 | Observability & Monitoring Views | 4/13 |
| P396 | Workforce & State Machine Visualization | 3/3 |
| P397 | Budget & Spending Control Center | 3/3 |
| P398 | OAuth2 Security & Access Control | 3/3 |
| P399 | User Co-Orchestration Interface | 3/3 |
| P402 | Universal Configuration System: Eliminate Hardcoded Landmines for Multi-Tenant Adoption | 0/13 |
| P404 | Agent Scratch Space Management & Auto-Reaper | 15/21 |
| P405 | STATE-58 Revision: Holistic Architecture Documentation from Database Proposals | 27/32 |
| P406 | Model Library v2: Complete Cost Matrix & Spawn Routing Enforcement | 0/8 |
| P407 | Orchestrator retry cascade: 10,632 SPAWN_POLICY_VIOLATION + 38 AGENT_DEAD escalations | 0/5 |
| P408 | Dead Code Cleanup: Remove 2 Unused Modules + 4 Orphaned Tests (~2,247 lines) | 6/6 |
| P409 | fn_sync_proposal_maturity Bug: Resets COMPLETE Proposals to mature (P381) | 0/11 |
| P410 | Workflow source-of-truth split-brain across docs, runtime templates, and UI constants | 0/7 |
| P411 | Registry-backed runtime config for provider and project decoupling | 5/5 |
| P412 | postWorkOffer drops project_id, breaking multi-project work isolation | 6/6 |
| P413 | Consolidate AgentHive service accounts and runtime identities | 7/7 |
| P414 | Migrate MCP server from SSE to Streamable HTTP transport | 7/7 |
| P415 | Add MCP readiness and observability checks | 8/8 |
| P416 | Normalize AgentHive config and environment loading | 0/10 |
| P417 | Repair build gate and CI-equivalent checks | 9/9 |
| P428 | Enhance DRAFT proposal with acceptance criteria, design rationale, and implementation plan | 3/3 |
| P430 | Control DB Boundary: classify every table as control, project, or projection | 3/3 |
| P431 | Control Database Bootstrap: create agenthive_control with versioned schemas | 3/3 |
| P432 | Project Domain Database Isolation: per-project DBs registered in agenthive_control | 3/3 |
| P433 | Dispatch and Agency Hardening: stable agencies, ephemeral workers, fail-closed claims | 3/3 |
| P434 | Provider Route and Budget Governance: token plans, API key plans, hierarchical budgets | 3/3 |
| P435 | Control Panel Observability: web/TUI/mobile feeds with causal IDs and stop scopes | 9/9 |
| P436 | Schema Reconciliation for Control Plane: resolve drift, classify proposal/workflow | 3/3 |
| P439 | State Machine Concurrency Ceilings: hard active-claim limits per scope | 3/3 |
| P440 | Dispatch Retry and Terminal Semantics: same row, attempt counter, terminal states | 3/3 |
| P441 | Service Topology Ownership: one owner per state-machine responsibility | 5/5 |
| P442 | Operator Stop and Cancel Controls: DB-backed cancel, suspend, drain, terminate | 6/6 |
| P443 | State Feed Causal IDs: every feed event carries project, dispatch, claim, run, route, budget context | 5/5 |
| P444 | Host, Provider, and Route Separation: untangle host identity from provider and agency | 6/6 |
| P445 | State Machine Race Integration Tests: duplicate polls, concurrent claims, retry, cancel, budget | 5/5 |
| P446 | MCP Runtime Reliability: structured errors, health, transport compatibility, deploy visibility | 11/11 |
| P447 | Cubic Worktree Path Normalization: canonical /data/code/worktree/<name> root | 0/4 |
| P448 | Multi-tenant path/user hardcoding cascade — provider switch is destructive | 5/5 |
| P449 | MCP URL and daemon URL hardcoded across 30+ files — blocks multi-host MCP | 0/4 |
| P450 | cli-builders.ts defaultModel() bypasses DB model_routes — 5 hardcoded model fallbacks | 0/4 |
| P451 | Workflow state literals hardcoded across 20+ TS files — bypasses SMDL as source of truth | 0/5 |
| P452 | Tracked source folders littered with agent scratch — P403 not enforced | 0/4 |
| P453 | Workflow-state typed accessor module — single SMDL/DB-resolved source for all state and maturity names | 0/4 |
| P454 | Extract scan-hardcoding to standalone @agenthive/scan package with multi-pack rule library | 8/8 |
| P455 | hive CLI: structured replacement for roadmap CLI — daily design + operations surface | 3/3 |
| P456 | MCP handler argument-naming inconsistency — every action uses different camelCase/snake_case | 7/7 |
| P457 | proposal_discussions.context_prefix CHECK rejects gate-decision/ship-verification/handoff prefixes | 0/3 |
| P458 | cubic_list returns 12.8MB by default — needs pagination + status default | 0/4 |
| P459 | cubic_create role slots must respect queue-role profiles and explicit agent identity | 7/7 |
| P460 | fn_spawn_workflow trigger doesn't always create roadmap.workflows row | 0/7 |
| P461 | prop_update silently ignores type changes — no error, no warning, no effect | 0/6 |
| P462 | Cubic agent identifier sanitization missing — names with spaces and parens leak into worktree paths | 0/8 |
| P463 | Agency Liaison and Two-Way Orchestrator Protocol — agency-level representation, dormancy, capacity-aware claims | 6/6 |
| P464 | Liaison spec, agency registration, and dormancy state machine | 0/3 |
| P465 | Subscription-aware claim policy in liaisons — 5h/daily/weekly/monthly window detection | 11/11 |
| P466 | Spawn briefing protocol — parent assembles warm-boot payload before spawning a child agent | 0/3 |
| P467 | Subagent stuck-detection and auto-escalation — N-strikes, forced checkpoints | 0/3 |
| P468 | Two-way orchestrator↔liaison messaging protocol — control + telemetry plane, idempotent, replay-safe | 10/10 |
| P469 | Liaison and agency observability surface — web/TUI feeds for operator visibility | 3/3 |
| P470 | add_dependency MCP handler writes to in-memory singleton, not Postgres | 0/0 |
| P472 | Unified auth and identity model — keys, sessions, tokens, OAuth across agents/liaisons/operators | 0/7 |
| P474 | Configuration resolution-order spec — env vs roadmap.yaml vs control DB vs feature flags | 0/35 |
| P475 | MCP Tool Surface Contract Hardening — single-source schema, runtime validation, action=help | 7/7 |
| P476 | Review verdict vocabulary expansion + post-gate change tracking | 0/0 |
| P483 | Project lifecycle operations — create/attach/archive/delete + operator playbook | 9/21 |
| P486 | MCP router extractArgs hardening + tool-name collision detection | 4/4 |
| P495 | Per-project tenant DB bootstrap + connection registry (supersedes P482) | 0/5 |
| P496 | File-based vault adapter for tenant DSN secrets (Stage A2 of P429) | 0/0 |
| P499 | PgBouncer in front of Postgres for tenant + control pool fanout (Stage A5 of P429) | 20/20 |
| P500 | Two-tier DB test infrastructure with single-DB compatibility flag (Stage A6 of P429) | 0/0 |
| P501 | hiveControl database creation + control-plane DDL deployment (Stage B1 of P429) | 0/0 |
| P502 | Logical replication agenthive→hiveControl for control-plane baseline + tail (Stage B2 of P429) | 0/0 |
| P503 | Control-plane read-shadow flag for delta detection (Stage B3 of P429) | 0/0 |
| P504 | Cutover rehearsal on production-clone Postgres (Stage C1 of P429) | 0/0 |
| P505 | Production cutover PLAN FREEZE: lock the runbook before execution (Stage C2a of P429) | 0/0 |
| P506 | Drop control schemas from agenthive AND drop dead project_id columns (Stage C3 of P429) | 0/0 |
| P507 | Self-grandfather agenthive as project_id=1 tenant DB via project_attach (Stage D2 of P429) | 0/0 |
| P508 | Tenant schema bootstrap templates (database/ddl/tenant/) (Stage D3 of P429) | 6/7 |
| P509 | Tenant DB ops bundle: pg_dump cron + monitoring + backup retention (Stage D4 of P429) | 12/13 |
| P510 | Drop project_id columns from shared control-plane tables (Stage E1 of P429 cleanup) | 0/0 |
| P511 | Drop agenthive→hiveControl FDW views (Stage E2 of P429 cleanup) | 0/0 |
| P512 | Remove AGENTHIVE_DB_MODE=single test-mode flag (Stage E3 of P429 cleanup) | 0/0 |
| P513 | Bring up monkeyKing-audio tenant DB (Stage F1 of P429) | 13/13 |
| P514 | Bring up georgia-singer tenant DB (Stage F2 of P429) | 13/13 |
| P515 | Vault v2: HashiCorp Vault or AWS Secrets Manager for tenant DSNs (Stage G1 of P429) | 10/10 |
| P516 | Per-project git repo separation (tenant code lives in tenant repos) (Stage G2 of P429) | 11/11 |
| P517 | Move a tenant DB to a dedicated Postgres host (operational pattern) | 0/0 |
| P518 | Production cutover EXECUTE: agenthive control schemas → hiveControl (Stage C2b of P429) | 0/5 |
| P519 | Rewrite multi-project Phase 1 tests off vitest onto node:test (urgent unblock) | 0/0 |
| P520 | DDL drift sentinel during cutover window (Stage B/C safety net for P429) | 0/0 |
| P521 | submit_review FK opacity blocks subagent reviews — needs auto-register or typed error | 0/0 |
| P523 | HOTFIX: Share single MCP server across all SSE + StreamableHTTP sessions | 5/6 |
| P524 | Unified Feature Flag System — DB-backed, hot-reloadable, per-tenant | 0/0 |
| P525 | Global DDL Migration Runner with Rollback Policy — control-plane versioning | 0/0 |
| P526 | Structured Agent Error Catalog with Auto-Recovery — unified failure modes and retry policies | 0/0 |
| P590 | hiveCentral data-model overhaul (parent) | 0/0 |
| P602 | dependency schema — cross-project graph (was P530.11) | 15/15 |
| P604 | observability schema — spans, lifecycle events, routing, explainability (was P530.13) | 12/12 |
| P605 | governance schema — hash-chained decision log and event spine (was P530.14) | 0/10 |
| P608 | Proposal tiering — Class A/B/C (was P530.17) | 0/7 |
| P610 | Per-(type × gate) agent profiles for the gating loop | 12/24 |
| P613 | Auto-advance reconciler: gate_decision_log advance verdict must flip proposal.status | 46/46 |
| P614 | Consolidated agency liveness — heartbeat, missed-job alarm, poke probe, dormancy demotion | 0/41 |
| P659 | Operator-as-Gate-Agent: dashboard write proxy + advance/hold/split/combine actions | 9/9 |
| P660 | Documenter dispatch loop — close workflow row on completion | 0/12 |
| P661 | Stale squad_dispatch reconciler — close dispatches whose agent_runs died | 23/23 |
| P671 | Short-lease default + split-on-overrun + background e2e verifier for COMPLETE/active | 23/23 |
| P673 | Architecture-type proposal lifecycle: POC, tech-stack / model selection, tuning | 0/10 |
| P675 | Schema-drift monitor — log scrape, auto-hotfix proposal with parent linkage, escalation on repeat | 21/21 |
| P676 | PG role decomposition — roadmap_ro / roadmap_app / roadmap_admin | 18/18 |
| P677 | Pre-merge SQL column audit + migration linkage check | 20/20 |
| P686 | Schema-drift hotfix: roadmap.liaison_poke_attempt referenced after drop | 7/7 |
| P687 | HOTFIX: register 'architecture' proposal type for design / POC / model-selection / tuning workflows | 5/5 |
| P688 | AC2-verify: test architecture type registration (to be marked obsolete) | 3/3 |
| P689 | HOTFIX — dispatch circuit breaker: cap repeat (proposal, role) work-offer postings | 8/10 |
| P690 | Schema-drift hotfix: roadmap.agent_lifecycle_log referenced after drop | 13/13 |
| P704 | Maturity field is workflow-stage poisoned, not lease-state — wire lease triggers | 2/11 |
| P707 | Gate-Agent AC Verification Reform - Mandatory Evidence at D3 | 0/6 |
| P720 | Activity Feed redesign — Discord posts + roadmap-board live panel | 8/8 |
| P721 | Detect Claude usage-cap exits as throttle, not failure (don't trip circuit breaker) | 0/0 |
| P738 | HOTFIX HF-B: developer/enhancer prompts must not self-promote maturity | 0/5 |
| P739 | HOTFIX HF-A: dispatcher must claim gate-ready proposals as gate-reviewer, not developer | 0/5 |
| P740 | HOTFIX HF-C: gate-evaluator must verify persistence + demote maturity on non-approve verdicts | 0/7 |
| P741 | HOTFIX HF-J/HF-F: lease auto-release on status transition + suppress gate-ready re-fire | 0/7 |
| P742 | HOTFIX HF-E: route picker must apply host_model_policy filter (fail closed on forbidden routes) | 0/6 |
| P743 | Remove hardcoded provider/agency 'hermes' literals — provider identity must live in DB only | 0/7 |
| P745 | Umbrella B — hiveCentral vNext data model first, tenant DB split after review | 0/16 |
| P748 | A1: queue-role profile schema keyed by workflow stage and maturity | 5/5 |
| P749 | A2: queue context resolver for scanQueues() | 5/5 |
| P750 | A3: lease-based single-flight and expired-work requeue recovery | 2/5 |
| P751 | A4: readiness scoring and role selection inside the unified queue scanner | 3/5 |
| P752 | A5: orchestrator maintenance wake-ups and offer reaper after queue unification | 3/4 |
| P753 | A6: retire transition_queue (audit + drop migration + rollback) | 3/4 |
| P754 | A7: decommission agenthive-gate-pipeline.service + delete pipeline-cron.ts | 0/5 |
| P755 | B1: control-plane boundary classification + database/control-plane-tables.md register | 0/5 |
| P756 | B2: hiveCentral DB bootstrap (provisioning script + role grants + credentials) | 0/5 |
| P757 | B3: migrate control-plane tables out of agenthive into hiveCentral | 0/5 |
| P758 | B4: tenant-DB provisioning + project registry (hiveCentral.project) | 0/5 |
| P759 | B5: code rewire — every getPool() caller routes to hiveCentral or tenant pool | 0/5 |
| P760 | B6: project_capacity_config schema + seed (per-project dispatch + token budget) | 0/5 |
| P761 | C1: agency liveness state consumed by resolve_agency, implemented in TypeScript | 0/5 |
| P762 | C2 DROPPED: separate heartbeat cron absorbed by liaison wake-ups and scanQueues() | 0/5 |
| P763 | C3: spawn-failure counter feeding TypeScript agency resolver | 0/6 |
| P764 | C4: tenant-aware agency in-flight capacity for resolve_agency | 0/5 |
| P765 | C5: auto-recovery and scope-aware alerting from liaison/scanner liveness | 5/5 |
| P766 | C6: operator action surface for liaison pause/resume/retire | 4/5 |
| P767 | D1: project_route_policy schema + seed (per-project route allowlist + token-budget caps) | 0/5 |
| P768 | D2: agency_route_policy schema + seed (per-agency route restrictions) | 5/5 |
| P769 | D3: queue-role route constraints on agent_role_profile | 0/5 |
| P770 | D4: per-(project, route) hourly token-budget table + window resetter | 0/5 |
| P771 | D5: extend resolveModelRoute() with the 4 new filter layers (project + agency + role + budget) | 6/6 |
| P772 | D6: route_decision_log audit table + write hook in resolveModelRoute | 0/5 |
| P773 | D7: fallback chain when chosen route throttled (next eligible by priority) | 0/5 |
| P774 | P706-C1: Migration — workflow vocab unification (Hotfix→3-stage, drop Quick Fix) | 5/7 |
| P775 | P706-C2: Workflow-stages registry loader + drop hardcoded state constants from src/core + src/shared | 0/4 |
| P776 | P706-C3: Web Board — force Workflow filter + dynamic columns from workflow_stages | 2/3 |
| P777 | P706-C4: TUI Board — force Workflow filter + dynamic columns + filter row redesign | 7/7 |
| P778 | P706-C5: Gate-evaluator closure verdicts → maturity=obsolete + obsoleted_reason | 10/10 |
| P779 | P706-C6: Scanner rule + CI guard — flag legacy state literals as migration artifacts | 3/3 |
| P780 | P706-C7: Documentation — CONVENTIONS.md §2 + agentGuide.md updates for unified vocabulary | 4/4 |
| P786 | Gap: TypeScript hot-path debt blocks CI and obscures Claude change regressions | 6/6 |
| P787 | Gap: Runtime endpoint resolution is still env-only after P449/P431 realignment | 6/6 |
| P788 | Gap: hive-cli operator domains still return stubs for model, budget, route, provider, knowledge, and scan | 0/7 |
| P789 | Gap: test runner and migration-number hygiene regressed after recent main changes | 0/6 |
| P796 | Provider health tracking — async query endpoint | 5/5 |
| P797 | Model list registry — fix multi-platform filtering | 5/5 |
| P798 | Multi-platform subscription model architecture — split concerns | 5/5 |
| P801 | Fix: last-activity row not visible in proposal modal sidebar | 5/5 |
| P802 | Dashboard-web portal gap report: wiring defects across non-board/proposal pages | 7/12 |
| P821 | AgentHive V2: single-database architecture (agentHive2) | 0/7 |
| P823 | V2: agentHive2 database baseline — deploy/ DDL + seed | 5/5 |
| P825 | V2: SMDL migration — remove BUILTIN_SMDLS, DB-only workflow definitions | 6/6 |
| P826 | V2: application code migration — schema-aware pool + search_path | 0/5 |
| P827 | P474 Phase 2: RegistryKeys + FlagKeys DB resolution via hiveCentral | 16/19 |
| P828 | P474 Phase 3: Config mutation surface + audit log | 38/50 |
| P833 | A2A Unified Message Envelope — extend message_ledger + ACK/reply MCP tools | 0/0 |
| P834 | A2A Identity & Trust — agent_secret, HMAC dispatch gate, spawn grant verification | 13/13 |
| P835 | A2A Message Reliability — timeout tracking cron, dead letter, escalation paths | 0/4 |
| P836 | A2A Cross-Host Delivery — HTTP callback relay via agent_registry | 2/2 |
| P837 | A2A Legacy Cleanup — consolidate liaison_message into message_ledger, delete relay.ts | 0/0 |
| P840 | Wire ConfigResolver into pool.ts — eliminate bare process.env.PG* reads | 3/10 |
| P841 | Agent Authentication & Resource Access Distribution Architecture | 6/13 |
| P842 | P841-D: Hard Budget Enforcement per Agent (Principal-Based Spending Caps) | 7/14 |
| P843 | P841-A: MCP Auth Middleware — PrincipalVerifier Integration & Transport Intercepts | 4/4 |
| P844 | P841-B: Pool Identity Gating — agent_project_roles + AsyncLocalStorage DB Gate | 6/6 |
| P845 | P841-C: Spawned Agent Env Sanitization (C1) — Strip GITHUB_TOKEN + *_SECRET/*_PASSWORD | 5/5 |
| P846 | Operator Agency Registration & A2A Response Closure | 0/12 |
| P851 | P841 Follow-up: Fix POST /mcp bearer verification + write MERGE e2e test suite | 0/11 |
| P852 | Readable Agent Names — model_routes.abbr + structured identity (rt-host-exp-n) | 0/13 |
| P854 | P844 pool gate gap: propagate _auth principal into agentContextStorage inside callTool() | 1/5 |
| P855 | HOTFIX: fn_claim_work_offer 'proposal_id is ambiguous' blocks all OfferProvider claims | 0/3 |
| P888 | A2A foundation deploy gap — fn_a2a_message_notify never installed; per-agent pg_notify silently inert | 0/5 |
| P891 | G1 (audit): camelCase identifier folding fix — agentHive2 DDL silently lowercased | 6/6 |
| P892 | G2 (audit): port observability schema (P604) into agentHive2 control plane | 6/6 |
| P893 | G3 (audit): tenant lifecycle state machine for agentHive2 (port P601) | 5/5 |
| P894 | G4 (audit): partition maintenance job for agentHive2 time-series tables | 0/0 |
| P895 | G5 (audit): backup harness + verify cron for agentHive2 | 7/7 |
| P896 | G6 (audit): cross-project dependency graph + consistency check for agentHive2 | 7/7 |
| P897 | G7 (audit): budget unblock reserve on spBudget for cross-project deadlock prevention | 14/14 |
| P898 | G8 (audit): DLQ replay/inspect MCP actions for agentHive2 messaging | 10/10 |
| P899 | G9 (audit): kbEmbedding IVFFlat index auto-creation in project-init | 4/4 |
| P900 | P835 follow-up: persist escalation_failure_count so poison-pill survives timeout-cron restart | 7/7 |
| P901 | G10 (audit): central registries (template/credential/workforce) for agentHive2 cross-project share | 15/15 |
| P902 | A8: collapse scripts/orchestrator.ts entrypoint into the unified Orchestrator class | 10/10 |
| P903 | P902-A: Shim + lifecycle wiring (no behavior changes) | 0/6 |
| P906 | P902-C: Reconciler notify-only (eliminate app.gate_bypass mutation path) | 5/5 |
| P907 | A2A reply/thread/broadcast semantics — standardize after P888 deploys | 3/3 |
| P909 | P902-E: Resolver cleanup (sweep dead duplicate, audit gate-role-resolver boundary) | 3/3 |
| P912 | Agency self-registration and liaison bootstrap on provider startup | 7/8 |
| P913 | HOTFIX: agency-self-registration.ts — wrong FK type, no transaction, race on concurrent calls | 7/7 |
| P914 | HOTFIX: push-dispatch payload missing offer_id/claim_token — zero offers claimed since P912 cutover | 0/0 |
| P915 | Tighten roadmap.v_agency_status dispatchable threshold from 10min to 60s | 9/12 |
| P918 | Agency runtime contract + shared messaging gateway libraries | 0/8 |
| P919 | Tiered Agent Identity — Human-Readable Roles + Scalable Instances | 13/13 |
| P920 | P918-1: CLI invocation registry (shared library) | 5/9 |
| P921 | P918-2: Active liaison session uniqueness (DB invariant) | 6/15 |
| P922 | P918-3: Host-aware notification optimization (additive) | 7/14 |
| P923 | P918-4: Discord external routing bridge (separate adapter, isolated concerns) | 0/19 |
| P924 | P918-5: Multi-host recovery and polling semantics | 0/21 |
| P928 | Agent registry route binding — surface current backend on agent identities | 0/10 |
| P929 | P919-B: Live feed alias rendering + worker Tier 2 auto-assign fix | 2/4 |
| P930 | Generic agency systemd template + retire per-provider service units + new agency identity format | 7/7 |
| P931 | P929-A: assignDisplayAlias Tier 2 latent bug — algorithmic Title-Case + correct provider derivation | 7/7 |
| P932 | P929-B: wire claimDisplayAlias into the actual worker INSERT path | 11/11 |
| P933 | P929-C: live feed alias rendering — SQL JOIN + DB-driven host strip | 7/8 |
| P934 | Lease release semantics: release_reason required + enumerated + maturity-mapped | 14/15 |
| P990 | Enforce message_ledger nonce uniqueness for A2A replay prevention | 3/3 |
| P991 | P834 Phase 4: enforce HMAC sig_verified on msg_send (flag-gated) | 4/4 |
| P992 | P935 — Agentic task execution via liaison message bus | 4/4 |
| P993 | A2A Agentic Task Protocol — Stateful Liaison Orchestration | 8/8 |
| P994 | P993 Phase 2 — Task Protocol Completeness (task_ack fields, AC verification on complete) | 4/4 |
| P995 | agentHive2 proposal stack re-authoring into documentation-shaped architecture | 11/11 |
| P996 | Permanent agent naming and liaison identity convention | 16/18 |
| P997 | P995-A: legacy-to-agentHive2 proposal mapping artifact schema | 11/11 |
| P998 | P995-B: proposal corpus inventory seed and classification pass | 5/5 |
| P1000 | P995-0: proposal structure and documentation projection audit | 7/7 |
| P1001 | HOTFIX: proposal display_id truncates four-digit IDs after P999 | 5/5 |
| P1003 | P1000-B: restore architecture proposal workflow registry | 6/6 |
| P1004 | Agent Cost & Quota Self-Reporting — Provider-Aware Budget Intelligence | 8/8 |
| P1005 | Task Tier Routing — Free-Model Labour Pool for Mechanical Ops | 0/10 |
| P1007 | P907-A: A2A reply-semantics P1 fixes — msg_send correlation_id + msg_reply reply_to | 4/4 |
| P1008 | P907-B: A2A reply-semantics P2 fixes — escalation, A2AMessenger, liaison handlers | 0/0 |
| P1018 | Wire CLI Token Capture into Existing Budget Tables — make schema-complete budget machinery actually work | 17/17 |
| P1029 | OpenClaw Provider Adapter — WebSocket-based agent runtime interface | 14/16 |
| P1065 | TUI Board — Agent Presence & Per-Agent Messaging/Trust Inspector | 25/26 |
| P1066 | TUI Config Flag Editor — runtime_flag browse, edit, audit, live-reload | 8/41 |
| P1067 | TUI Operator Shell — shared runtime, panel switcher, common LISTEN client | 24/24 |
| P1068 | Role-Defined Subagent Identity — agency-agents as Living Behavioral Library with MCP Delivery | 10/10 |
| P1070 | Research: MoE / Bandit / Bounded-Update Algorithm Survey + Baseline Catalog + Capability Taxonomy Design | 0/13 |
| P1071 | MCP Proposal API — add_reference, set_parent, and action-param routing fix | 11/11 |
| P1072 | Vault adapter DB integration: wire control_credential.vault_provider + credential | 21/26 |
| P1073 | P997-B: prop_list parent_id filter + mcp_get_proposal_projection children field | 6/6 |
| P1093 | Agent Registry Reaper — periodic prune of stale identity rows | 8/12 |
| P1094 | Merge Gate (D4) — D4 role binding fix + audit (premise reframed) | 6/8 |
| P1095 | MCP Server + Liaison Process Topology Audit + Documentation | 8/13 |
| P1097 | HOTFIX cross-host-relay: signature verifier hardcodes path='/' while sender signs real callback path | 0/10 |
| P1098 | P1017 follow-on: enforce 'exp' claim on USER bearer tokens (max 1h window) | 10/10 |
| P1099 | P1017 follow-on: normalize agent identity slashes before compare (homography defence) | 10/10 |
| P1100 | P1017 follow-on: per-sender rate limit on msg_send to prevent channel flooding | 10/12 |
| P1102 | P1017-A: Phase A — stop heartbeat pollution + archive historical rows | 3/3 |
| P1104 | P1017-C: Phase C — presence state machine (presence_state, fn_pulse, agency_presence_changed) | 6/6 |
| P1107 | P1107: Transport Contracts & Binary Regression Guards | 6/9 |
| P1109 | Encapsulate agent-side DB operations behind MCP tools — close raw-SQL footguns | 14/15 |
| P1113 | Role-Based Persona Injection for Spawned Agents | 20/20 |
| P1114 | Tiered clearance for MCP tools — every action declares a minimum trust_tier + role | 7/7 |
| P1115 | D4-gate-smoke-test-alpha — synthetic merge gate validation | 0/0 |
| P1116 | D4-gate-smoke-test-beta — synthetic merge gate validation | 0/0 |
| P1117 | D4-gate-smoke-test-gamma — synthetic merge gate validation | 0/0 |
| P1120 | P1107 child: operator user-inbox consumer — surface user/<operator> messages | 29/29 |
| P1123 | HOTFIX agenthive-board pool poisoning — stray pool.end() kills long-running services | 12/12 |
| P1124 | D4 Merge-Gate E2E Validator — dispatch-wired AC verification job (P1094 Branch C) | 10/10 |
| P1126 | P1120 child: consumer resilience — exit on PG disconnect so systemd Restart=always actually triggers | 13/13 |
| P1128 | Replace jiti TypeScript runtime in long-running Node services (named-export collapse bug) | 7/7 |
| P1129 | Self-service agency registration via MCP — agency_register / register_model / agency_start | 11/23 |
| P1131 | HOTFIX gate-review cluster-detection alarm — surface rubber-stamp bursts | 0/11 |
| P1132 | A2A Host Service Consolidation — collapse N per-agency daemons into 1 per-host A2A | 12/12 |
| P1135 | P1095-child: hive doctor topology check — runtime verification of agency-to-host attachment | 12/12 |
| P1138 | HOTFIX A2A host PG reconnect + LISTEN recovery — close the silent-failure window | 5/7 |
| P1139 | TUI single-screen refactor — honor P247 Tab cycle without per-view screen.destroy | 5/8 |
| P1142 | P1138-child: per-agency LISTEN client error → exit(1) (A2A host only) | 9/9 |
| P1144 | Orchestrator env constants migration to core.runtime_flag (task #40 follow-on) | 12/14 |
| P1289 | Stop silent orchestrator dispatch failures and route core dispatch through observable offer lifecycle | 0/5 |
| P1290 | Align dispatched role capabilities with seeded agency vocabulary | 7/7 |
| P1291 | Auto-pause repeated no-eligible-agency dispatch loops per proposal and role | 10/10 |
| P1292 | P1289-A4: Route implicit-gate dispatch through offer lifecycle | 8/8 |
| P1293 | P1289-A6: Replay harness for no-eligible-agency dispatch failure loop | 7/7 |
| P1339 | fn_pulse bridge to provider_registry — closes P1132 a2a-host migration | 9/9 |
| P1340 | MCP gate-flow ergonomics — auto-advance + param aliases + clearer help | 7/7 |
| P1350 | Workforce identity model overhaul: nested agents, capabilities, agency-agent integration | 8/8 |
| P1351 | P1350-A: Nested agents under parent agencies (identity model) | 8/8 |
| P1352 | P1350-B: Personality + long-term memory schema for permanent agents | 7/7 |
| P1355 | P1350-D: Incorporate agency-agent open-source project conventions | 25/25 |
| P1356 | P1355-A: Schema migration — personality JSONB + display metadata on agent_registry | 6/6 |
| P1357 | P1355-B: OpenClaw workspace export adapter | 5/5 |
| P1358 | P1355-C: Agency-agents catalog import — 144+ definitions as inactive agent seeds | 16/18 |
| P1359 | Per-(provider, model) quota cooldown + automatic route fallback | 7/7 |
| P1360 | Wire spawn failure into agency throttle counters + worktree score — prevent loop, not just detect | 15/15 |
| P1364 | MCP add_discussion: reject empty body (close the fabrication shortcut) | 6/7 |
| P1365 | Pre-emptive LLM throttle: parse rate-limit headers from live API responses + gradual backoff | 12/12 |
| P1366 | Wire P996 short-name through offer/claim/coordination — populate worker_identity at every lifecycle stage | 7/9 |
| P1367 | P996 amendment: hyphen separator + LLM variant slot for agency aliases | 8/8 |
| P1369 | P1359 follow-up: switch spawn-with-retry test mocks to bun:test mock.module | 3/3 |
| P1371 | NoteHandlers.createNote empty-body validation (P1364 sibling) | 7/7 |
| P1374 | P1365-B: Cockpit ready/cooling split + headroom indicator (AC-6 follow-up) | 7/8 |
| P1375 | P1365-C: Call logThrottleDecision from the resolver path (AC-8 follow-up) | 5/5 |
| P1376 | P1365-D: GREATEST() merge between proactive and reactive cooldowns (AC-9 follow-up) | 6/7 |
| P1377 | TUI workforce panel: count math + agency vs provider definition mismatch | 13/13 |
| P1379 | Hotfix: schema drift — default_cost_estimate_tokens + provider_capacity_defaults missing | 0/4 |
| P1380 | Hotfix: OfferDispatchHandler acks 'ok' on unhandled spawn error — work silently lost | 0/6 |
| P1381 | Hotfix: 15 of 18 agencies fail liaisonRegister with 'Agency X not registered' | 0/4 |
| P1382 | Hotfix: set_maturity reason argument silently dropped — audit trail unparseable | 0/4 |
| P1383 | TUI baseline v0.8 — product definition anchored at git tag v0.8-tui-baseline | 12/12 |
| P1385 | MCP-native agency work transport (subscribe / submit / heartbeat) — zero-install remote agencies | 15/17 |
| P1386 | Architect role early-exit when all ACs pass and design complete | 6/7 |
| P1387 | MCP proposal-surface DX: teach future agents which write action is visible | 5/5 |
| P1388 | Decision: add_discussion board visibility — implement endpoint or deprecate in favour of submit_review | 6/8 |
| P1389 | Audit all MCP write surfaces for parameter fidelity — silent input drops are a recurring bug class | 10/10 |
| P1392 | Tier-1 persona injection into agency-agent (Tier-2) spawn | 6/7 |
| P1393 | hotfix: respect gate_scanner_paused + exclude rate_limited from dispatch-loop counter | 3/4 |
| P1406 | hotfix: extend dispatch-loop counter to exclude lease_expired failures (P1393 sibling) | 0/4 |
| P1408 | hotfix: liaison-agent crashes on UUID message_id from liaison_message bus (channel collision) | 5/6 |
| P1409 | hotfix: MCP proposal_reviews.create silently drops is_blocking=true (sibling of P1389) | 4/4 |
| P1411 | Audit raw SELECTs against roadmap_proposal.proposal for gate_scanner_paused filter | 7/7 |
| P1431 | hotfix: liaison reply messageType uses 'status' (rejected by CHECK constraint) | 0/4 |
| P1432 | Orchestration V3 — agency self-claim marketplace (umbrella) | 6/7 |
| P1433 | V3-C1: Atomic DB claim primitive + offer/lease lifecycle correctness | 5/5 |
| P1434 | V3-C2: Cause-aware dispatch circuit breaker (failure_class taxonomy) | 4/4 |
| P1435 | V3-C3: Per-(OS-user, provider) auth model + fail-loud | 5/5 |
| P1436 | V3-C4: Provider truth at spawn (close the lying registry) | 3/4 |
| P1437 | V3-C5: Presence heartbeat + orphan-session self-heal + channel contract registry | 3/4 |
| P1438 | V3-C6: Smart AI-agent liaison with emergent presence — orchestrator becomes pure matchmaker | 13/19 |
| P1439 | V3-C7: Deliverable verification (artifact, not exit code) | 0/4 |
| P1440 | V3-C8: Capability matching + per-role/provider timeout budgets + quota-as-routing | 0/4 |
| P1444 | Fix MCP agency tools and register Gemini agency | 5/5 |
| P1445 | Multi-agent concurrency isolation: worktree-per-agent + lease-gated branch/main writes | 5/6 |
| P1447 | Complete the P1132 a2a-host cutover — retire per-agency liaison units | 18/18 |
| P1456 | P1350-E: Session-instance identities for concurrent interactive CLI sessions | 17/18 |
| P1457 | Refined Agent SCM Canon + Workflow Orchestration Promotion | 4/4 |
| P1611 | hotfix: GET /api/routes returns 500 — Routes page dead, P387 orphan-badge UX unreachable | 1/1 |
| P1612 | hotfix: GET /api/pulse returns 500 — pulse/health surface unreachable from web | 1/1 |
| P1613 | hotfix: /api/proposals silently ignores `limit` query param — returns all 1448+ rows (11MB) every page load | 1/1 |
| P1614 | hotfix: /api/version returns hardcoded 'v0.0.0' — operator cannot verify deployed build | 1/1 |
| P1681 | Obsolete superseded DRAFT/new proposals after June 2026 compatibility review | 6/6 |
| P1682 | Duration-aware usage-limit handling: claude-CLI detection → cooldown → hold-and-wake | 9/9 |
| P1696 | issue: dashboard server returns HTTP 404 for unknown SPA paths — deep-links to new routes break | 1/1 |
| P1697 | Phase 1: Hot-configurable global in-flight dispatch cap (no restart) | 0/0 |
| P1698 | Phase 2: Per-agency dispatch cap via MCP/CLI action | 9/9 |
| P1699 | Phase 3: Dynamic usage-driven dispatch capacity controller (AIMD) | 2/3 |
| P1729 | Cumulative gate convergence guard — auto-pause slow re-dispatch loops | 5/5 |
| P1730 | Eliminate spawn livelock — per-spawn MCP-init isolation/timeout for the 20-min zero-output failures | 3/4 |
| P1731 | issue: /agents page renders 'Agents (0) / No agents registered' despite /api/agents returning 300+ rows | 4/4 |
| P1858 | Provider-truth ENFORCEMENT + coherent capability/provider binding at spawn | 0/5 |
| P1859 | Provider usage probe — the missing P1004 writer (subscription /usage endpoint) | 8/8 |
| P1967 | Long-lived CLAUDE_CODE_OAUTH_TOKEN for spawn workers (eliminate OAuth-expiry 401 storms) | 6/6 |
| P2313 | Migration runner + tracker — stop schema drift from breaking orchestrator restarts | 5/5 |
| P2322 | Insulate live services from agent checkout contamination (dedicated deploy checkout) | 5/5 |
| P2323 | Stop test fixtures polluting the live DB: test isolation + agent/agency reaper | 5/5 |
| P2324 | A2A task_request delivery is deaf — messages marked read but no worker spawns | 4/4 |
| P2325 | legacy-dispatch pins work to worktree=codex-four — provider-welded offers wedge the queue | 10/10 |
| P2335 | Reintroduce Cubic Workspace Acquisition Into Offer Dispatch (project-scoped) | 14/14 |
| P2404 | Reconcile liveness poke with cold-wake liaisons: fresh heartbeat must override stale timed-out poke | 3/5 |
| P2408 | Antigravity (agy) spawn adapter — buildAntigravityArgs + agent_cli dispatch | 5/7 |
| P2496 | Offer-generator terminal-state hardening — COMPLETE proposals post zero offers | 6/6 |
| P2709 | Bulk reeval job flaps maturity new<->mature across all gate-eligible proposals | 5/5 |
| P2754 | P150 (and possibly others) cannot transition DEVELOP→MERGE — 'not allowed for this workflow' | 5/5 |
| P2755 | gate_decision MCP shortcut never advances status — handler writes to_state=from_state | 5/5 |
| P2756 | Workflow drift root cause + guard: proposal creation seeds workflows-table template disagreeing with proposal_type_config | 8/8 |
| P2969 | fn_apply_gate_advance: attribute auto-advance discussion note to the real decider | 6/6 |
| P2995 | Architecture Research: Multi-Agent Platform Patterns — Orchestration, Lifecycle, Trust & Self-Evolution | 7/7 |
| P2999 | P2995-AC4: Step-wise attribution and reward signals for proposal work | 0/8 |
| P3000 | P2995-AC6: Heterogeneous per-agent cost quotas and starvation prevention | 10/10 |
| P3001 | MCP add_discussion silently stores empty body — row created, body not persisted | 4/4 |
| P3198 | issue: long-running services hang on SIGTERM — stop only completes via systemd timeout kill | 3/4 |
| P3309 | Adaptive Work–Model Matching: dynamic difficulty × capability × reliability × cost/quota routing | 5/5 |
| P3310 | Child A: Dynamic task-difficulty / required-capability signal per work item | 4/4 |
| P3311 | Child B: Reliability ledger — per-(model/agency × task-class) success scoring from agent_runs | 7/7 |
| P3312 | Child C: Unified matcher decision function + reliability-aware tier downshift | 9/9 |
| P3313 | Child D: Closed feedback loop + decision log + reliability floors + operator override | 5/5 |
| P3314 | Orchestrator offer-dedup guard — don't re-post a live (proposal, role) offer | 2/2 |
| P3315 | Stale liaison_task_tracker rows wedge A2A task_requests — 'tracker initialization error' blocks codex dispatch | 5/5 |
| P3325 | Fix gate_decision advance mapping — should advance one stage, not jump to COMPLETE | 5/8 |
| P3326 | Gate/transition workflow drift: gate_decision D2 advances REVIEW→COMPLETE (skips DEVELOP) | 6/6 |
| P3507 | P477-B: Control-plane portal shell + cross-project aggregation views (Fleet/Efficiency/Identity/Platform) | 12/12 |
| P3508 | P477-C: Multi-project access control — project-creation ACLs + token/route scoping | 9/9 |

---

## 🔀 MERGE (1)

| ID | Title | AC |
|----|-------|----|
| P1441 | V3-C9: Rollout step 1 — claude-gary-bot single agency, 1→N workers (e2e gate) | 2/6 |

---

## 🔨 DEVELOP (9)

| ID | Title | AC |
|----|-------|----|
| P477 | Web control-plane redesign for multi-project AgentHive operations | 12/13 |
| P1024 | Pillar 8: Web and Operator Experience — Dashboard, Operator CLI, TUI Board, Activity Feed, Discord Bridge | 5/9 |
| P1391 | Lease lifecycle as TTL + first-class hold/reject verdict wiring | 13/50 |
| P1442 | V3-C10: Rollout steps 2-4 — multi-agency, multi-OS-user, multi-host | 1/6 |
| P2326 | Ad-hoc A2A task bucket (sentinel proposal for no-proposal task_requests) | 11/11 |
| P3535 | Decouple maturity lifecycle from lease occupancy — monotonic progress + lease-based exclusive claim | 11/11 |
| P3564 | Board pg pool doesn't survive a Postgres restart — route queries via pgbouncer + auto-heal pool | 0/6 |
| P3566 | Gate-advance authorization integrity (non-terminal gates): independent reviewer, blocking-review respected | 5/8 |
| P3798 | Docs update sweep: stale proposal references, V2 architecture, CLI migration | 3/3 |

---

## 🔍 REVIEW (10)

| ID | Title | AC |
|----|-------|----|
| P3781 | Configuration Management: categorize runtime_flag, web config UI, and hardcoded-constant migration | 0/14 |
| P3784 | Config introspection API: list all config keys with category, value, default, scope, editability | 0/11 |
| P3785 | Web config interface: category-grouped browse + audited inline edit in dashboard | 0/12 |
| P3787 | Hardcoded-constant migration: inventory + move high-value core/infra literals into categorized runtime flags | 0/7 |
| P3793 | Codebase Gap Analysis: architecture, implementation, operational, and governance gaps | 2/5 |
| P3794 | CI: SIGTERM regression test suite for long-running services | 0/5 |
| P3795 | Hard routing gate on provider health — block dispatch to unhealthy providers | 0/7 |
| P3796 | Monolith decomposition plan: roadmap.ts (6191 lines) and server/index.ts (6761 lines) | 0/24 |
| P3797 | Wire agenthive-scan-* rule packs as required CI gates in .gitlab-ci.yml | 0/5 |
| P3840 | Unified orchestrator job-posting pool — post offers for every non-terminal proposal | 0/7 |

---

## 📝 DRAFT (5)

| ID | Title | AC |
|----|-------|----|
| P3563 | Acceptance loop must have ground truth: independent, evidenced, non-vacuous AC verification as a hard gate invariant | 12/12 |
| P3565 | Intake triage + risk-tiering: proposals opt-IN to autonomy, high-blast-radius work requires human approval | 2/17 |
| P3782 | Config taxonomy: add category to runtime_flag schema + ConfigKey registry + set() schema reconciliation | 0/10 |
| P3839 | Gating-as-a-job: mature proposals must post a claimable gate-decision job at every gate (D1-D4) | 0/7 |
| P3841 | Enforce revised P996 agent naming — clean-slate re-registration + validator | 0/7 |
