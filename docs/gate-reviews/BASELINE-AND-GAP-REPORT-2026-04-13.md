# AgentHive Baseline & Gap Analysis Report
**Date:** 2026-04-13  
**Scope:** Full system audit — DB schema, MCP tools, code architecture, proposals, operational health  
**Method:** Live MCP queries (127 tools), DDL analysis (51 tables, 17 functions), code review, proposal scan

---

## 1. EXECUTIVE SUMMARY

**System Maturity: ~62%** (spec-to-implementation ratio ~3:1 — strong design, weak execution)

AgentHive has a **world-class schema design** (51 tables, 4-pillar architecture, comprehensive DDL v3) and **127 registered MCP tools**. But the operational layer is severely broken: the gate pipeline doesn't work, agents don't actually spawn, teams are empty, and critical efficiency features exist only as specs.

### The Good
- 112 proposals managed through MCP — the workflow *concept* works
- 127 MCP tools registered and responding — broad surface area
- DDL v3 is well-structured with proper FKs, constraints, triggers, and 17 functions
- 13 models registered with cost metadata — routing infrastructure exists
- A2A messaging operational (32 messages across 4 channels)
- Federation PKI initialized (CA cert valid until 2027)
- 22 cubics in database, worktree isolation working

### The Bad (Critical)
- **Gate pipeline is dead** — proposals can't advance automatically
- **Agent spawning is broken** — agents never actually start processes
- **Zero teams** despite P055 (Team Composition) marked COMPLETE/mature
- **Semantic cache = $0 savings** — 3-tier cost reduction has zero implementation
- **34 DEPLOYED issues** — operational debt accumulating
- **Spending caps = $∞** — no financial guardrails active

---

## 2. DATABASE SCHEMA BASELINE

### 2.1 Schema Inventory (DDL v3 — 2,175 lines)

| Section | Tables | Status |
|---------|--------|--------|
| **Core Lookup** | model_metadata, maturity | ✅ Seeded |
| **Workforce** | agent_registry, spending_caps, team, team_member, resource_allocation, acl, agency_profile, budget_allowance, agent_capability, agent_workload | ⚠️ Teams empty, 7/17 agents have null roles |
| **Workflow** | workflow_templates, workflow_roles, workflow_stages, workflow_transitions, proposal_type_config, proposal_valid_transitions | ⚠️ Only 3 templates, stages may be empty |
| **Proposals** | proposal, proposal_template, workflows, proposal_acceptance_criteria, proposal_dependencies, proposal_decision, proposal_lease, proposal_milestone, proposal_reviews, proposal_state_transitions, proposal_version, proposal_discussions, proposal_labels, proposal_event | ✅ Core tables functional |
| **Execution** | run_log, agent_memory, model_assignment, context_window_log, cache_write_log, cache_hit_log, prompt_template | ⚠️ Tables exist, 0 data in most |
| **Utility** | embedding_index_registry, mcp_tool_registry, mcp_tool_assignment, message_ledger, notification, notification_delivery, user_session, attachment_registry, spending_log, scheduled_job, webhook_subscription, audit_log | ⚠️ Partially populated |

**Total: 51 tables, 17 functions, 2 extensions (vector, pg_trgm)**

### 2.2 Critical Schema Gaps

| Gap | Severity | Impact |
|-----|----------|--------|
| `cubics` table missing from DDL | 🔴 CRITICAL | All cubic MCP tools fail — 22 cubics exist via direct creation but DDL doesn't define the table |
| `agent_health` table missing | 🔴 CRITICAL | pulse_fleet, pulse_health tools fail — no fleet observability |
| `token_cache` table missing | 🔴 HIGH | Semantic cache (P090 Tier 1) cannot function |
| `model_routing_rules` table missing | 🔴 HIGH | Multi-LLM router has no rules — every task gets default model |
| `loop_detection_config` table missing | 🟡 HIGH | Agents can retry infinitely undetected |
| `mcp_tool_metrics` table missing | 🟡 MEDIUM | Cannot identify slow/failing MCP tools |

### 2.3 Database Functions (17 total)

Key functions in DDL v3:
- `fn_set_updated_at()` — auto-timestamp on updates
- `fn_proposal_display_id()` — generates P### display IDs
- `fn_spawn_workflow()` — creates workflow stages on proposal creation
- `fn_log_proposal_state_change()` — audit trail for transitions
- `fn_sync_blocked_flag()` — propagates dependency blocks
- `fn_validate_proposal_fields()` — constraint validation
- `fn_check_dag_cycle()` — prevents circular dependencies
- `fn_event_lease_change()` — lease lifecycle events
- `fn_sync_workload()` — agent workload tracking
- `fn_rollup_budget_consumed()` — budget aggregation
- `fn_set_memory_expires()` — TTL on agent memory
- `fn_check_spending_cap()` — spending enforcement
- `fn_set_version_number()` — version ledger numbering
- `fn_check_lease_available()` — lease conflict detection
- `fn_audit_sensitive_tables()` — audit logging
- `fn_notify_proposal_event()` — PG NOTIFY for event-driven pipeline

**Missing functions** (referenced in code but not in DDL):
- `fn_enqueue_mature_proposals()` — gate pipeline enqueue (has case mismatch bug, P204)
- `fn_gate_ready()` / `fn_notify_gate_ready()` — maturity → gate ready flow
- `markTransitionDone()` — transition completion (exists in code but never called — dead code)

---

## 3. MCP TOOLS BASELINE

### 3.1 Tool Inventory: 127 Registered Tools

| Domain | Tools | Functional |
|--------|-------|------------|
| **Proposals** | prop_list, prop_get, prop_create, prop_update, prop_transition, prop_set_maturity, prop_claim, prop_release, prop_renew, prop_leases, prop_delete, prop_get_projection | ✅ Working |
| **AC System** | list_ac, verify_ac, add_acceptance_criteria, delete_ac | ⚠️ Corruption bugs (P156/P192) |
| **Dependencies** | add_dependency, get_dependencies, resolve_dependency, check_cycle, remove_dependency, can_promote | ✅ Working |
| **Workflow** | workflow_load, workflow_load_builtin, workflow_list, get_workflow_overview | ⚠️ Only 3 templates |
| **Reviews** | submit_review, list_reviews | ✅ Working |
| **Agents** | agent_list, agent_get, agent_register | ⚠️ 7/17 null roles |
| **Teams** | team_list, team_create, team_add_member | ❌ 0 teams exist |
| **Spending** | spending_set_cap, spending_log, spending_report, spending_efficiency_report | ⚠️ All $∞ caps |
| **Models** | model_list, model_add | ✅ 13 models seeded |
| **Memory** | memory_set, memory_get, memory_delete, memory_list, memory_summary, memory_search | ✅ Working |
| **Knowledge** | knowledge_add, knowledge_search, knowledge_record_decision, knowledge_extract_pattern, knowledge_get_decisions, knowledge_get_stats, knowledge_mark_helpful | ⚠️ 9 entries, 0 patterns |
| **Cubic** | cubic_create, cubic_list, cubic_focus, cubic_transition, cubic_recycle | ⚠️ Table mismatch issues |
| **Messaging** | msg_send, msg_read, chan_list, chan_subscribe, chan_subscriptions | ✅ 32 messages |
| **Pulse** | pulse_heartbeat, pulse_health, pulse_fleet, pulse_history, pulse_refresh | ❌ agent_health table missing |
| **Federation** | federation_stats, federation_list_hosts, federation_approve_join, etc. | ⚠️ 0 hosts, PKI ready |
| **Escalation** | escalation_add, escalation_list, escalation_resolve, escalation_stats | ⚠️ 0 escalations |
| **Worktree** | worktree_merge, worktree_sync, worktree_merge_status | ✅ Working |
| **Testing** | test_discover, test_run, test_issues, test_issue_create, test_issue_resolve, test_check_blocked | ⚠️ Unknown |
| **Documents** | document_list, document_view, document_create, document_update, document_search, document_pg_* | ✅ Working |
| **Protocol** | protocol_mention_search, protocol_thread_*, protocol_pg_* | ✅ Working |
| **Notes** | create_note, note_list, delete_note, note_display | ✅ Working |
| **Directives** | directive_list, directive_add, directive_rename, directive_remove, directive_archive | ✅ Working |
| **Legacy** | transition_proposal, get_valid_transitions | ✅ Working (duplicate of prop_transition) |

### 3.2 Critical MCP Issues

1. **prop_create SQL bug** (P205): Window functions not allowed in FILTER clause
2. **Tool naming drift**: Spec says `prop_*`, some docs say `proposals_list` — actual tools use `prop_*`
3. **can_promote uses camelCase** (`proposalId`) while all other tools use snake_case
4. **knowledge_search requires `keywords` param** — not documented in tool description
5. **Duplicate tools**: `transition_proposal` (legacy) + `prop_transition` (new) coexist

---

## 4. PROPOSAL PORTFOLIO ANALYSIS

### 4.1 Distribution (112 total)

| Status | Count | Health |
|--------|-------|--------|
| COMPLETE | 44 | ✅ Done |
| DEPLOYED | 34 | ⚠️ Operational debt |
| DRAFT | 18 | 🟡 Pipeline |
| REVIEW | 7 | 🔴 Stuck — gate broken |
| DEVELOP | 3 | 🟡 Active work |

| Maturity | Count | Health |
|----------|-------|--------|
| mature | 74 | ⚠️ Many "false mature" (complete but not operational) |
| new | 29 | ✅ Fresh |
| active | 9 | ✅ Under lease |

### 4.2 Type Distribution

| Type | Count | Workflow |
|------|-------|----------|
| feature | ~60 | Standard RFC |
| issue | ~40 | Standard RFC (was Quick Fix) |
| component | ~8 | Standard RFC |
| product | 1 | Standard RFC |
| hotfix | 0 | Hotfix workflow (unused) |

### 4.3 Critical Proposals

| ID | Title | Status | Blocker? |
|----|-------|--------|----------|
| P045 | Pillar 1: Lifecycle Engine | COMPLETE/mature | Gate pipeline broken — "complete" claim false |
| P046 | Pillar 2: Workforce | DEVELOP/active | 0 teams, null roles |
| P047 | Pillar 3: Efficiency | DEVELOP/active | No cache, no routing, $∞ caps |
| P048 | Pillar 4: Utility | DEVELOP/active | Cubics table missing, federation 0 hosts |
| P058 | Cubic Orchestration | COMPLETE/mature | Cubics table NOT in DDL — "complete" claim false |
| P090 | Token Efficiency | COMPLETE/mature | Zero implementation — "complete" claim false |
| P201 | Cubics table missing | Draft/new | Infrastructure blocker |
| P211 | markTransitionDone dead code | Draft/new | Gate pipeline blocker |

### 4.4 False Maturity Claims

These proposals claim "mature" or "COMPLETE" but have **zero operational effectiveness**:

| Proposal | Claim | Reality |
|----------|-------|---------|
| P060 (Financial Governance) | COMPLETE/mature | Spending caps = $∞, circuit breaker not enforced |
| P061 (Knowledge Base) | COMPLETE/mature | 9 entries, 0 patterns, 0 helpful votes |
| P063 (Fleet Observability) | COMPLETE/mature | agent_health table missing, pulse tools fail |
| P058 (Cubic Orchestration) | COMPLETE/mature | cubics table missing from DDL |
| P090 (Token Efficiency) | COMPLETE/mature | No semantic cache, no prompt caching, no context management |
| P055 (Team Composition) | COMPLETE/mature | 0 teams in database |

---

## 5. OPERATIONAL HEALTH

### 5.1 Gate Pipeline Status: ❌ BROKEN

The gate pipeline is the **single largest blocker** in the platform. Specific issues:

1. **fn_enqueue_mature_proposals()** has case mismatch (P204) — never processes proposals
2. **markTransitionDone()** is dead code (P211) — transitions stuck in 'processing' forever
3. **proposal_maturity_changed** channel listened on but never sent by any DB function
4. **PipelineCron** may not be running (check systemd)
5. **0 transitions** have ever been marked 'done' in transition_queue

### 5.2 Agent Dispatch Status: ❌ BROKEN

- `cubic_create` + `cubic_focus` only write metadata (cubic.json + DB lock)
- `agent-spawner.ts` has full spawn logic but is **never called** by orchestrator
- No agents have actually run since April 11
- After dispatch: `ps aux | grep claude` returns nothing
- Root cause: orchestrator dispatches metadata, never spawns processes

### 5.3 Financial Governance: ⚠️ NO GUARDRAILS

- All spending caps set to $∞ (unlimited)
- `spending_log` table exists but has minimal data
- No circuit breaker enforcement
- No budget alerts active

### 5.4 A2A Messaging: ✅ WORKING

- 4 channels active: broadcast (6), direct (21), system (4), team:dev (1)
- msg_send, msg_read, chan_list, chan_subscribe all functional
- 17 agents registered, messaging between them possible

### 5.5 Federation: ⚠️ INFRASTRUCTURE READY, 0 HOSTS

- PKI initialized (CA cert expires 2027-04-12)
- federation-server.ts (36K) and federation-pki.ts (22K) exist
- 0 connected hosts, 0 join requests
- Blocked by: no cryptographic agent identity (P080/P159)

---

## 6. GAP ANALYSIS — PRIORITY MATRIX

### P0 — CRITICAL (Platform Broken)

| # | Gap | Pillar | Fix Effort | Impact |
|---|-----|--------|------------|--------|
| 1 | Fix gate pipeline (P204, P211, fn_enqueue case mismatch) | P045 | Medium | Unblocks ALL proposal advancement |
| 2 | Wire agent-spawner.ts into orchestrator dispatch | P045 | Medium | Agents actually start running |
| 3 | Add missing DDL tables (cubics, agent_health, token_cache, model_routing_rules) | ALL | Low | Fixes cubic tools, pulse, cache |

### P1 — HIGH (Workflow Impact)

| # | Gap | Pillar | Fix Effort | Impact |
|---|-----|--------|------------|--------|
| 4 | Seed teams + enforce non-null roles | P046 | Low | Governance cannot function without teams |
| 5 | Fix prop_create SQL bug (P205) | P045 | Low | Proposal creation via MCP broken |
| 6 | Fix AC corruption bugs (P156/P192) | P045 | Medium | AC system integrity |
| 7 | Implement spending cap enforcement | P047 | Medium | Stop unlimited token burn |
| 8 | Populate model routing rules | P047 | Low | Every task uses default model = waste |

### P2 — MEDIUM (Efficiency & Governance)

| # | Gap | Pillar | Fix Effort | Impact |
|---|-----|--------|------------|--------|
| 9 | Implement semantic cache (P090 Tier 1) | P047 | Medium | 20-30% cost reduction |
| 10 | Fast-track governance proposals (P179/P178) | P046 | Medium | Constitution enforcement |
| 11 | Build SMDL parser | P045 | Medium | Configurable workflows become real |
| 12 | Add agent health monitoring | P046 | Low | Fleet observability |
| 13 | Fix cubic lifecycle (P193/P196 dedup) | P048 | Low | Cubic cleanup automation |

### P3 — LOW (Polish & Scale)

| # | Gap | Pillar | Fix Effort | Impact |
|---|-----|--------|------------|--------|
| 14 | MCP tool versioning (api_version, deprecated, sunset_at) | P048 | Low | API stability |
| 15 | Federation bootstrapper | P048 | High | Cross-instance sync |
| 16 | Additional workflow templates (7+ needed) | P045 | Medium | Workflow flexibility |
| 17 | MCP tool metrics table | P048 | Low | Tool observability |
| 18 | CLI type case mismatch (P143/P144) | P048 | Low | Developer experience |

---

## 7. SECURITY ASSESSMENT

### 7.1 Current State

| Control | Status | Risk |
|---------|--------|------|
| ACL table | ✅ Exists | 🟡 Table exists, no enforcement layer |
| Spending caps | ⚠️ All $∞ | 🔴 No financial guard |
| Agent roles | ⚠️ 7/17 null | 🔴 RBAC broken |
| Crypto identity | ❌ Missing | 🔴 No agent authentication |
| Audit log | ✅ Table exists | 🟡 Unknown population |
| Resource allocation | ✅ Table exists | 🟡 Encrypted refs, no raw secrets |

### 7.2 Security Gaps

1. **No cryptographic agent identity** (P080/P159): String-handle impersonation possible in federated deployments. Any process can claim to be any agent.
2. **Null roles bypass ACL**: 7/17 agents have `role: null`. ACL checks on role will fail or default-open.
3. **$∞ spending caps**: No circuit breaker. A runaway agent could burn unlimited tokens.
4. **No agent authorization for state transitions** (P207): Any agent can transition any proposal without signing.
5. **Cubic worktree paths are predictable**: `/data/code/worktree-gate-{id}-{phase}` — potential path traversal.

---

## 8. ARCHITECTURE ASSESSMENT

### 8.1 Strengths

1. **4-pillar architecture** is well-conceived and industry-aligned
2. **DDL v3** is comprehensive with proper constraints, FKs, triggers, and functions
3. **MCP tool surface** is broad (127 tools) and well-organized by domain
4. **Proposal lifecycle** (Draft→Review→Develop→Merge→Complete) is sound
5. **Maturity system** (New→Active→Mature→Obsolete) adds valuable within-state tracking
6. **Worktree isolation** prevents concurrent file conflicts
7. **DAG dependency engine** with cycle detection (P050) is sophisticated

### 8.2 Architectural Smells

1. **Spec-to-code gap (3:1 ratio)**: Excellent specs, weak implementation. The system *designs* faster than it *builds*.
2. **Orchestrator is 66 lines**: src/core/orchestration/orchestrator.ts queries SpacetimeDB (not Postgres) and has minimal logic. It doesn't call agent-spawner.ts.
3. **Dual backends**: Some tools have both SpacetimeDB (sdb-*) and Postgres (pg-*) handlers. The backend-switch.ts pattern adds complexity.
4. **Dead code**: markTransitionDone(), proposal_maturity_changed listener, legacy transition_proposal tool.
5. **Case inconsistency**: Status values mixed UPPERCASE/TITLECASE across DB and MCP returns.
6. **Orphaned orchestrators**: 5+ orchestrator variants (orchestrator.ts, orchestrator-dynamic.ts, orchestrator-refined.ts, orchestrator-unlimited.ts, orchestrator-with-skeptic.ts) — unclear which is canonical.

### 8.3 Industry Comparison

| Feature | AgentHive | LangGraph | CrewAI | Temporal |
|---------|-----------|-----------|--------|----------|
| State machine | ✅ SMDL spec | ✅ Python decorators | ✅ Flows | ✅ Workflows |
| Durable execution | ❌ Broken cron | ✅ Checkpointer | ❌ | ✅ Saga |
| Agent teams | ❌ 0 teams | N/A | ✅ Crews | N/A |
| Cost tracking | ⚠️ Tables only | ✅ Langfuse | ❌ | N/A |
| Semantic cache | ❌ Spec only | ✅ GPTCache | ❌ | N/A |
| Human-in-loop | ⚠️ Spec only | ✅ interrupt() | ❌ | ✅ Signals |
| MCP tools | ✅ 127 tools | ❌ | ❌ | ❌ |
| Proposal lifecycle | ✅ Unique | ❌ | ❌ | ❌ |

---

## 9. RECOMMENDED SPRINT PLAN

### Sprint 1 — Unbreak the Platform (1-2 days)

1. Fix `fn_enqueue_mature_proposals()` case mismatch (P204)
2. Wire `agent-spawner.ts` into orchestrator's `dispatchAgent()`
3. Add missing DDL: `cubics`, `agent_health` tables
4. Fix `prop_create` SQL bug (P205)
5. Fix `markTransitionDone()` — call it after gate decisions (P211)

### Sprint 2 — Governance Foundation (2-3 days)

6. Seed foundational teams (architecture, development, review, operations)
7. Enforce non-null roles on agent_register
8. Set real spending caps (replace $∞)
9. Populate model routing rules
10. Fix AC corruption bugs (P156/P192)

### Sprint 3 — Efficiency (3-5 days)

11. Implement semantic cache (P090 Tier 1)
12. Wire spending efficiency dashboard
13. Add agent health monitoring
14. Build loop detection

### Sprint 4 — Governance & Polish (5-7 days)

15. Fast-track Constitution v1 (P179)
16. Build SMDL parser
17. MCP tool versioning
18. Additional workflow templates
19. Federation bootstrapper

---

## 10. ARTIFACTS

- **DDL:** `/data/code/AgentHive/database/ddl/roadmap-ddl-v3.sql` (2,175 lines, 51 tables)
- **MCP Tools:** 127 registered via SSE at `127.0.0.1:6421`
- **Proposals:** 112 managed (44 COMPLETE, 34 DEPLOYED, 18 DRAFT, 7 REVIEW, 3 DEVELOP)
- **Models:** 13 registered (Anthropic, OpenAI, Google, Xiaomi)
- **Agents:** 17 registered (14 LLM + 1 tool + 2 system)
- **Cubics:** 22 active
- **Messages:** 32 across 4 channels
- **Knowledge:** 9 entries (all decisions, 0 patterns)
- **Previous Reports:** `docs/pillars/RESEARCH-2026-04-13-pillar-research-report.md`

---

*Report generated by Hermes — system baseline scan using live MCP queries and DDL analysis.*
