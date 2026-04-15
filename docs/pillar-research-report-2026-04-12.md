# AgentHive Pillar Research Report
**Date:** 2026-04-12 | **Researcher:** Pillar Research Agent (Hermes)
**Method:** Live MCP inspection, source analysis, proposal review, runtime diagnostics

---

## Executive Summary

All four pillars have **significant operational gaps** despite mature code completion. The system is architecturally sound but operationally hollow — core infrastructure exists but is populated with minimal data, missing runtime dependencies, or not wired to live services. **12 critical gaps** identified across all pillars, with **5 blocking issues** that prevent the platform from functioning as designed.

| Pillar | Status | Maturity | Operational Gap | Severity |
|--------|--------|----------|-----------------|----------|
| P045 — Proposal Lifecycle | COMPLETE | Mature | Gate pipeline not running | 🔴 Critical |
| P046 — Workforce Management | DEVELOP | Active | Zero teams, null agent roles | 🔴 Critical |
| P047 — Efficiency & Finance | DEVELOP | Active | No token data, health table missing | 🟡 High |
| P048 — Utility Layer | DEVELOP | Active | Zero federation, 13 stub pages | 🟡 High |

---

## PILLAR 1: Universal Proposal Lifecycle Engine (P045)

### ✅ What's Working
- 3 workflow templates operational (Standard RFC, Quick Fix, Code Review)
- DAG dependency engine complete (P050) with cycle detection
- AC system structurally complete (P052)
- Version ledger and audit trail operational (P053)
- 56 SQL migrations applied, schema stable

### 🔴 Critical Gaps

#### GAP 1.1: Gate Pipeline Not Running
**Evidence:** P151 (PipelineCron gate worker not running), P152 (MCP server does not initialize gate pipeline)
**Impact:** State machine transitions have no engine to process them. AutoTransitionEngine, DecisionQueue, and gate evaluators are missing at startup. Proposals can be manually transitioned but automated gate decisions (D1, D2, D3) are not executed.
**Recommendation:** Wire the gate pipeline startup into the MCP server initialization. Create a `gate-pipeline.service` systemd unit or integrate into existing `hermes-gate-pipeline` service.

#### GAP 1.2: Limited Workflow Templates
**Evidence:** Only 3 workflows (RFC-5, Quick Fix, Code Review) vs. 5 proposal types in CLAUDE.md.
**Impact:** Feature proposals, bug fixes, and hotfix proposals share the RFC workflow, which has unnecessary stages for simple tasks. No dedicated Feature Development, Bug Fix, Incident Response, or Research Spike templates.
**Recommendation:** Add 3-4 workflow templates:
- **Feature Dev** (5 stages: Design → Implement → Test → Review → Merge)
- **Bug Fix** (4 stages: Reproduce → Fix → Verify → Close)
- **Incident Response** (3 stages: Detect → Mitigate → Post-Mortem)
- **Research Spike** (3 stages: Scope → Investigate → Report)

#### GAP 1.3: AC System Bugs
**Evidence:** P156 (add_acceptance_criteria splits text into characters), P157 (verify_ac returns undefined), P158 (list_ac returns 600+ items)
**Impact:** Acceptance criteria cannot be reliably added or verified, undermining the core "pass-all before promotion" gate.
**Recommendation:** Fix the AC text storage to treat input as a single AC string, not character-by-character.

### 🟡 Moderate Gaps

#### GAP 1.4: No Maturity Auto-Progression
**Evidence:** P077 noted maturity never updated on status transitions. While fixed, there is no automated mechanism to detect when a proposal should transition from "New" → "Active" → "Mature" based on activity signals (lease duration, commit count, AC verification).
**Recommendation:** Add a maturity evaluator to the gate pipeline that auto-advances maturity based on measurable activity thresholds.

---

## PILLAR 2: Workforce Management & Agent Governance (P046)

### ✅ What's Working
- 17 agents registered in agent_registry
- Agent registration via MCP functional (P054)
- Lease & claim protocol structurally complete (P056)
- ACL and DB role security in place (P057)

### 🔴 Critical Gaps

#### GAP 2.1: Zero Teams Defined
**Evidence:** `team_list` returns "No teams found." Despite P055 (Team & Squad Composition) being marked COMPLETE.
**Impact:** The entire team-based coordination layer is inert. No squad assembly, no team-scoped memory, no role-based dispatch is possible without teams.
**Recommendation:** Create foundational teams aligned to the 4 pillars:
- `lifecycle-team` (proposal engine operators)
- `workforce-team` (agent governance)
- `efficiency-team` (cost & context)
- `platform-team` (CLI/MCP/federation)
- `orchestrator-team` (cross-pillar coordination)

#### GAP 2.2: Null Agent Roles
**Evidence:** 7 of 17 agents have `role: null` (codex, develop-agent, gate-agent, hermes-agent, proposal-reviewer, rfc-gate-evaluator, system).
**Impact:** Role-gated transitions (`allowed_roles` in proposal_valid_transitions) cannot be enforced. An agent with null role can bypass role-based access controls.
**Recommendation:** Assign explicit roles to all registered agents. Implement a role validation check in agent_register that rejects null roles.

#### GAP 2.3: No Cryptographic Agent Identity
**Evidence:** P080 (No cryptographic agent identity), P159 (agent_registry missing public_key column).
**Impact:** String-handle impersonation risk in federated deployments. Any agent can claim to be any other agent.
**Recommendation:** Apply migration 018 (agent-registry-crypto-identity) and enforce key-based identity verification in lease claims.

#### GAP 2.4: agent_health Table Missing
**Evidence:** `pulse_health` and `pulse_fleet` both fail with "relation roadmap.agent_health does not exist".
**Impact:** Fleet observability (P063) is non-functional. Cannot detect stalled agents, heartbeats are not persisted, and fleet-wide health monitoring is impossible.
**Recommendation:** Create the agent_health table via migration and wire pulse_heartbeat writes to it.

### 🟡 Moderate Gaps

#### GAP 2.5: No Agent Skill Matrix
**Evidence:** Agents register with skills but there is no matching system to route proposals to agents by skill.
**Recommendation:** Add a `skill_match(proposal_tags, agent_skills)` function to the cubic allocation logic.

---

## PILLAR 3: Efficiency, Context & Financial Governance (P047)

### ✅ What's Working
- Spending caps system structurally complete (P060)
- Model registry operational (P059)
- Knowledge base API functional (P061)
- Team memory API functional (P062)

### 🔴 Critical Gaps

#### GAP 3.1: Zero Token Efficiency Data
**Evidence:** `spending_efficiency_report` returns "No token efficiency data found."
**Impact:** P090 (Token Efficiency — Three-Tier Cost Reduction) is COMPLETE but produces no data. Cannot measure cache hit rates, prompt caching savings, or semantic cache effectiveness.
**Recommendation:** Wire the token efficiency metrics collection to actual LLM call logging. Migration 014 (token-efficiency-metrics) likely needs data population.

#### GAP 3.2: Knowledge Base Nearly Empty
**Evidence:** Only 4 entries (all decisions), 0 patterns, average 80% confidence. Only 2 contributors.
**Impact:** Cross-session intelligence is minimal. Agents re-derive known solutions. The vector search (pgvector) has nothing meaningful to search.
**Recommendation:** Establish a knowledge ingestion pipeline:
- Auto-extract patterns from completed proposals
- Record architectural decisions from gate review transcripts
- Seed with common AgentHive operational patterns

### 🟡 Moderate Gaps

#### GAP 3.3: No Cost Trend Analysis
**Evidence:** Spending system tracks per-call costs but has no trend analysis, anomaly detection, or forecasting.
**Recommendation:** Add a `spending_trend_report` tool that shows daily/weekly cost trends per agent, per model, with anomaly flagging for sudden spikes.

#### GAP 3.4: Context Window Optimization Not Measured
**Evidence:** No metrics on context utilization per agent session. Cannot determine if context management is actually reducing token usage.
**Recommendation:** Add context_utilization metrics to pulse_heartbeat: tokens_used / tokens_available ratio per session.

---

## PILLAR 4: Utility Layer — CLI, MCP Server & Federation (P048)

### ✅ What's Working
- MCP server operational with 100+ tools across 16 domains
- CLI functional (OpenClaw)
- 3 workflow resources served via MCP
- Document, note, and messaging systems available

### 🔴 Critical Gaps

#### GAP 4.1: Zero Federation Deployed
**Evidence:** `federation_stats` shows 0 hosts, 0 connections, 0 certificates. CA certificate valid until 2027 but no infrastructure connected.
**Impact:** Cross-instance collaboration is impossible. The platform cannot scale beyond a single deployment.
**Recommendation:** Stand up a second AgentHive instance and establish federation. Start with a staging-to-staging pair to validate the PKI and sync protocols.

#### GAP 4.2: 13 Unimplemented Dashboard Pages
**Evidence:** P160 (13 unimplemented dashboard-web page stubs — dead code since 2026-04-01).
**Impact:** Web dashboard is incomplete. Users see placeholder pages for critical views (spending, agents, proposals, etc.).
**Recommendation:** Prioritize and implement the 3 most critical dashboard views: Proposal Board, Agent Fleet Status, and Spending Gauges.

### 🟡 Moderate Gaps

#### GAP 4.3: WebSocket Bridge Stability
**Evidence:** P154 (roadmap board TUI hangs after loading Postgres data). Real-time updates unreliable.
**Recommendation:** Add connection retry logic, heartbeat-based liveness detection, and graceful degradation when WS disconnects.

#### GAP 4.4: CLI Proposal Type Case Mismatch
**Evidence:** P143 (CLI help text lists wrong types), P144 (CLI proposal create fails on type case mismatch).
**Recommendation:** Normalize proposal type handling to lowercase throughout CLI, MCP, and DB layers.

---

## Cross-Pillar Findings

### Finding 1: Operational Hollow Core
The platform has excellent structural completeness (56 migrations, 100+ MCP tools, 751 source files) but is operationally hollow:
- **0 active leases** (nobody is working)
- **0 teams** (no organizational structure)
- **0 federation hosts** (isolated instance)
- **0 token efficiency data** (no cost intelligence)
- **4 knowledge entries** (no institutional memory)

**Root Cause:** Development focused on building infrastructure, not populating or operating it. The platform needs an "Operational Bootstrap" initiative.

### Finding 2: Issue Debt Accumulation
23+ issue proposals (P069-P159), many marked DEPLOYED but questionable resolution:
- Issues P151-P158 are marked DEPLOYED but gate pipeline still not running
- AC system still has character-splitting bugs
- agent_health table still missing

**Recommendation:** Conduct an issue resolution audit. Re-test all "resolved" issues against live MCP to verify actual fix status.

### Finding 3: Missing Observability Feedback Loop
Pulse/P063 claims fleet observability but agent_health table doesn't exist, fleet status is empty, and no agents send heartbeats.

**Recommendation:** Create a "Pillar Health Dashboard" proposal that aggregates the operational state of all 4 pillars into a single view.

---

## Component Proposals

### NEW COMPONENT PROPOSAL: Operational Bootstrap Sequence
**Pillar:** Cross-cutting
**Priority:** P0 (Blocking)
**Description:** A one-time initialization sequence that:
1. Creates default teams for each pillar
2. Assigns roles to all registered agents
3. Seeds the knowledge base with architectural decisions
4. Verifies all migrations are applied and tables exist
5. Runs a health check against all MCP tools

### NEW COMPONENT PROPOSAL: Workflow Template Library
**Pillar:** P045
**Priority:** P1 (High)
**Description:** Expand from 3 to 8+ workflow templates covering all proposal types. Include role assignments, AC requirements per stage, and automated gate criteria.

### NEW COMPONENT PROPOSAL: Agent Skill Router
**Pillar:** P046
**Priority:** P2 (Medium)
**Description:** Match proposals to agents by skill tags, availability, and current lease load. Implement least-loaded routing for balanced fleet utilization.

### NEW COMPONENT PROPOSAL: Cost Intelligence Engine
**Pillar:** P047
**Priority:** P2 (Medium)
**Description:** Anomaly detection, trend forecasting, and per-proposal cost attribution. Alert when a single proposal exceeds expected token budget.

---

## Refinement Recommendations

### R1: Fix Gate Pipeline Startup (P045)
Wire AutoTransitionEngine and DecisionQueue initialization into MCP server startup. Estimated effort: 2-4 hours.

### R2: Create Default Teams (P046)
Use `team_create` and `team_add_member` MCP tools to establish organizational structure. Estimated effort: 1 hour.

### R3: Seed Knowledge Base (P047)
Extract architectural decisions from gate-decision-*.md docs and populate via `knowledge_add`. Estimated effort: 2-3 hours.

### R4: Fix AC Character Splitting (P045)
Patch the add_acceptance_criteria handler to store the full text as a single AC entry. Estimated effort: 30 minutes.

### R5: Create agent_health Table (P046/P047)
Write migration 022 for the agent_health table and wire pulse_heartbeat writes. Estimated effort: 1-2 hours.

### R6: Stand Up Federation Test Pair (P048)
Deploy a second instance and establish cross-instance proposal sync. Estimated effort: 4-8 hours.

---

## Data Sources
- Live MCP tool calls (prop_list, prop_get, agent_list, team_list, federation_stats, knowledge_get_stats, spending_efficiency_report, pulse_health, pulse_fleet, escalation_stats, prop_leases, workflow_load_builtin)
- Source file analysis (751 TypeScript files across 4 pillar directories)
- SQL migration audit (56 migration files)
- Gate decision documents (8 review transcripts from 2026-04-11/12)
- Project governance docs (CLAUDE.md, domain-architecture.md)

---

*Report generated by Hermes Pillar Research Agent — 2026-04-12T20:06:00Z*
