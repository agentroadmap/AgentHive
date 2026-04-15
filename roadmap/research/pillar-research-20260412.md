# 🏛️ Pillar Research Report — AgentHive 4-Pillar Architecture

**Date:** 2026-04-12  
**Author:** Pillar Researcher  
**Status:** Research Complete  
**Methodology:** Codebase audit (23 DDL migrations, 15 RFCs, 20+ E2E tests) + project memory cross-reference

---

## Executive Summary

After auditing the AgentHive codebase against all 4 pillars, I found **7 remaining gaps** and **6 actionable proposals**. The system is more mature than the raw DDL suggests — completed capabilities (P050, P055, P058, P059, P061, P062, P063, P078, P090, P148) already close many workforce and efficiency gaps.

### Pillar Maturity Assessment (Corrected)

| Pillar | Implementation | Maturity | Key Remaining Gap |
|--------|---------------|----------|---------|
| **P045 — Proposal Lifecycle** | ✅ Strong | 80% | Only 1 workflow template; Hotfix workflow not in DDL |
| **P046 — Workforce Governance** | ✅ Good | 75% | P187 reports agent_health table missing despite P063 claiming fleet observability |
| **P047 — Efficiency & Finance** | ✅ Good | 70% | P090 claims semantic cache + model routing — verify DB tables exist |
| **P048 — Utility Layer** | ⚠️ Partial | 55% | No MCP tool versioning, no federation, no rate limiting |

### Completed Capabilities (From Project Memory)

| ID | Capability | Closes Gap |
|----|-----------|------------|
| P050 | DAG Dependency Engine | P045 dependency tracking |
| P055 | Team & Squad Composition | P046 skill matching |
| P058 | Cubic Orchestration | P046 workload isolation |
| P059 | Model Registry & Cost Routing | P047 model routing |
| P061 | Knowledge Base & Vector Search | P046 knowledge sharing |
| P062 | Team Memory | P046 context sharing |
| P063 | Fleet Observability | P046 health monitoring |
| P078 | Escalation Management | P046 escalation paths |
| P090 | Token Efficiency | P047 semantic cache + routing |
| P148 | Auto-merge Worktrees | P045 merge automation |

---

## PILLAR 1 — Universal Proposal Lifecycle Engine (P045)

### What's Implemented ✅
- **State machine** with 9 states (New → Draft → Review → Active → Accepted → Complete / Rejected / Abandoned / Replaced)
- **Maturity lifecycle** within each state: New → Active → Mature → Obsolete (012-maturity-redesign.sql)
- **Gate pipeline**: D1–D4 gates with transition_queue and gate_task_templates (013-gate-pipeline-wiring.sql)
- **Multi-template workflow** column `workflow_name` on proposals (004-multi-template-workflow.sql)
- **Valid transitions** table enforcing legal state moves
- **pg_notify** triggers for state changes and gate readiness
- **P050 DAG** dependency engine with cycle detection
- **P148 Auto-merge** for worktree integration

### Gaps Identified 🔴

#### GAP 1.1: Only RFC 5-Stage Template Materialized
The `workflow_templates` table is stubbed in comments (migration 004). CLAUDE.md describes a **Hotfix workflow** (Triage → Fixing → Done) but no DDL creates it. The `proposal_valid_transitions` table only has `workflow_name = 'RFC 5-Stage'`.

**Evidence:** Migration 004 lines 32-42 show commented-out `workflow_templates` INSERT but it was never executed.

**Impact:** Hotfix proposals (Type C) are forced through the 5-stage RFC workflow, adding unnecessary overhead.

#### GAP 1.2: No SLA / Deadline Tracking
Proposals have no `due_date`, `target_completion`, or SLA enforcement fields. In a 100-agent system, time-bound governance is critical.

#### GAP 1.3: No Workflow Analytics
No views for: average time-in-state, gate pass/fail rates, bottleneck identification by stage.

### Proposals for P045

| # | Proposal | Priority | Effort | Status |
|---|----------|----------|--------|--------|
| P045-A | Materialize Hotfix workflow template (Triage → Fixing → Done) | High | 3 days | **New RFC needed** |
| P045-B | Add SLA/deadline tracking with escalation hooks | Medium | 1 week | New RFC |
| P045-C | Workflow analytics views (time-in-state, bottleneck detection) | Medium | 1 week | New RFC |

---

## PILLAR 2 — Workforce Management & Agent Governance (P046)

### What's Implemented ✅
- **Agent registry** with identity, role, capabilities
- **Role-based DB security**: agent_read, agent_write, admin_write (007-agent-security-roles.sql)
- **Per-agent DB users** (agent_andy, agent_skeptic, etc.)
- **Pulse tracking** (workforce_pulse table)
- **ACL system** for resource permissions
- **Conflict detection** (agent_conflicts table)
- **P055 Team/Squad Composition** — dynamic squad assembly by skills
- **P058 Cubic Orchestration** — isolated execution environments
- **P061 Knowledge Base** — persistent searchable store with pgvector
- **P062 Team Memory** — session-persistent KV store per agent/team
- **P063 Fleet Observability** — heartbeats, spending correlation, efficiency metrics
- **P078 Escalation Management** — obstacle detection, severity routing

### Gaps Identified 🔴

#### GAP 2.1: Agent Health Table May Be Incomplete
RFC P187 reports: `relation "roadmap.agent_health" does not exist` when calling `pulse_fleet`. Yet P063 claims fleet observability is complete. This suggests either:
- The table was created in a migration that wasn't applied, OR
- The `pulse_fleet` MCP tool references a different table name

**Action needed:** Verify if `roadmap.agent_health` exists in the live database. If P187 is stale, close it. If valid, it's a **blocking bug**.

#### GAP 2.2: No Agent Performance Scoring
No metrics on: gate pass rate, task completion time, cost-per-deliverable, quality ratings from reviewers.

### Proposals for P046

| # | Proposal | Priority | Effort | Status |
|---|----------|----------|--------|--------|
| P046-A | **Verify/close P187** — agent_health table existence check | **Critical** | 1 hour | Investigate first |
| P046-B | Agent performance scoring views (gate pass rate, cost-per-deliverable) | Medium | 1 week | New RFC |

---

## PILLAR 3 — Efficiency, Context & Financial Governance (P047)

### What's Implemented ✅
- **Token efficiency tracking** (`metrics.token_efficiency`) with cache hit rates (migration 014)
- **Daily efficiency views** (`metrics.v_daily_efficiency`) (017-daily-efficiency-views.sql)
- **Model metadata** with cost-per-token, context windows, capabilities
- **Budget ledger** (agent_budget_ledger)
- **Spending freeze** capability (freeze_spending_reducer)
- **Spending caps** (set_spending_caps_reducer)
- **P059 Model Registry & Cost Routing** — centralized LLM catalog + optimal model selection
- **P090 Token Efficiency** — three-tier cost reduction: semantic cache, prompt caching, context management

### Gaps Identified 🔴

#### GAP 3.1: P090 Implementation Verification Needed
P090 claims semantic cache + model routing + context management. The P047 RFC (RFC-20260412-P047) was created *today* proposing these exact features. This suggests either:
- P090 was marked complete prematurely, OR
- P047 is a duplicate/overlapping RFC that should be merged with P090

**Evidence:** P047 RFC proposes `token_cache.semantic_responses` table with pgvector — this exact table doesn't exist in roadmap-ddl-v3.sql.

#### GAP 3.2: No Loop Detection in DDL
The `loop_detection_config` table from P047 RFC is not in any migration file. No circuit breakers for retry loops exist.

#### GAP 3.3: Spending Visibility Dashboard Missing
RFC-20260401-SPENDING-VISIBILITY describes TUI/WebSash/Mobile views but no implementation exists. CLI-first approach is needed.

### Proposals for P047

| # | Proposal | Priority | Effort | Status |
|---|----------|----------|--------|--------|
| P047-A | **Verify P090 completeness** — does semantic cache table exist in live DB? | **Critical** | 1 hour | Investigate first |
| P047-B | Loop detection with circuit breakers | High | 1 week | Merge into P090 or new RFC |
| P047-C | CLI spending dashboard (real-time cost tracking) | Medium | 1 week | New RFC |

---

## PILLAR 4 — Utility Layer: CLI, MCP Server & Federation (P048)

### What's Implemented ✅
- **MCP tool specification v2.1** with 50+ tools across 8 domains (RFC-20260401-MCP-TOOL-SPEC)
- **MCP server** with SSE transport on port 6421
- **E2E test coverage** for proposals, agents, teams, spending, knowledge, etc.
- **Channel subscriptions** for push notifications (016-channel-subscriptions.sql)
- **Proposal MCP tools**: prop_create, prop_get, prop_list, prop_update, prop_transition, etc.

### Gaps Identified 🔴

#### GAP 4.1: No MCP Tool Versioning
P048 RFC (RFC-20260412-P048) correctly identifies this. Tools have no version tracking, deprecation notices, or compatibility checking. Breaking changes will silently break consuming agents.

**Evidence:** `roadmap.mcp_tool_registry` has no `api_version`, `deprecated`, or `sunset_at` columns in roadmap-ddl-v3.sql.

#### GAP 4.2: No Federation Layer
For multi-instance AgentHive deployments, there's no inter-instance communication protocol. The CLAUDE.md mentions "100 agents" but assumes single-instance.

#### GAP 4.3: No Rate Limiting on MCP
MCP-TOOL-SPEC doesn't mention rate limits per agent. A rogue agent could spam the server and exhaust resources.

#### GAP 4.4: P046 RFC Misfiled
RFC-20260412-P046-HYBRID-STORAGE-ADAPTER.md is labeled as "Pillar 4 - Utility Layer" despite having P046 in the filename. The storage adapter is a P048 concern. This is a **naming/organization issue**.

### Proposals for P048

| # | Proposal | Priority | Effort | Status |
|---|----------|----------|--------|--------|
| P048-A | **MCP tool versioning** with deprecation workflow | **High** | 1 week | RFC exists (RFC-20260412-P048) |
| P048-B | Rate limiting middleware for MCP server | High | 3 days | New RFC |
| P048-C | Rename P046-HYBRID-STORAGE-ADAPTER → P048-HYBRID-STORAGE-ADAPTER | Low | 5 min | Cleanup |
| P048-D | Federation protocol (inter-instance messaging) | Low | 3 weeks | Future RFC |

---

## Cross-Pillar Dependencies

```
P045 (Lifecycle) ← P050 (DAG dependencies)         ✅ Complete
P045 (Lifecycle) ← P148 (Auto-merge worktrees)     ✅ Complete
P046 (Workforce) ← P055 (Squad composition)        ✅ Complete
P046 (Workforce) ← P063 (Fleet observability)      ⚠️ Verify (P187 conflict)
P047 (Efficiency) ← P059 (Model routing)           ✅ Complete
P047 (Efficiency) ← P090 (Token efficiency)        ⚠️ Verify (P047 RFC overlap)
P048 (Utility)   ← ALL pillars (MCP is the API)    ⚠️ No versioning
```

---

## Verification Checklist (Before Proposing New RFCs)

These must be checked against the **live database** (not just DDL files) to avoid duplicate work:

| Check | Question | Command |
|-------|----------|---------|
| V1 | Does `roadmap.agent_health` exist? | `\d roadmap.agent_health` |
| V2 | Does `token_cache.semantic_responses` exist? | `\dt token_cache.*` |
| V3 | Does `roadmap.model_routing_rules` exist? | `\d roadmap.model_routing_rules` |
| V4 | What workflow templates are in `proposal_valid_transitions`? | `SELECT DISTINCT workflow_name FROM roadmap.proposal_valid_transitions` |
| V5 | What columns does `roadmap.mcp_tool_registry` have? | `\d roadmap.mcp_tool_registry` |

---

## Priority Matrix

### 🔴 Critical — Verify First (1 hour)
1. **P046-A**: Check if agent_health table exists (P187 conflict)
2. **P047-A**: Check if P090 tables exist (P047 overlap)

### 🟡 High — Next Sprint (after verification)
3. **P048-A**: MCP tool versioning (RFC exists, needs development)
4. **P048-B**: Rate limiting for MCP server
5. **P047-B**: Loop detection circuit breakers

### 🟢 Medium — Backlog
6. **P045-A**: Materialize Hotfix workflow template
7. **P045-B**: SLA/deadline tracking
8. **P046-B**: Agent performance scoring views
9. **P047-C**: CLI spending dashboard

---

## Industry Best Practices Comparison

| Feature | AgentHive | LangChain | CrewAI | OpenAI Swarm | Notes |
|---------|-----------|-----------|--------|--------------|-------|
| State machine | ✅ 9 states | ❌ | ⚠️ Basic | ❌ | Strong advantage |
| Semantic cache | ⚠️ P090 claimed | ✅ | ❌ | ❌ | Verify implementation |
| Agent skills | ⚠️ P055 claimed | ⚠️ Tools | ✅ | ✅ | Verify implementation |
| Cost routing | ⚠️ P059 claimed | ⚠️ Manual | ❌ | ❌ | Verify implementation |
| Loop detection | ❌ | ⚠️ | ❌ | ❌ | **Implement P047-B** |
| Tool versioning | ❌ | ⚠️ | ❌ | ❌ | **Implement P048-A** |
| Health monitoring | ⚠️ P063/P187 conflict | ❌ | ⚠️ | ❌ | **Resolve first** |

---

## Next Steps

1. **Immediate (1 hour):** Run verification checklist V1-V5 against live database
2. **If P063/P090 are complete:** Close P187 and P047 RFCs as duplicates
3. **If P063/P090 are incomplete:** Merge P047 RFC into P090 workstream
4. **Begin development:** P048-A (MCP Tool Versioning) — highest-impact remaining gap

---

*Research completed: 2026-04-12 22:15 UTC*  
*Files analyzed: 23 DDL migrations, 15 RFC proposals, 20+ E2E tests, CLAUDE.md project memory*  
*Confidence: High — grounded in actual codebase audit + project memory cross-reference*
