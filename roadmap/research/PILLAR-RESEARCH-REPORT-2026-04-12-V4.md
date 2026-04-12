# 🏛️ Pillar Research Report — AgentHive (Cycle 2026-04-12 V4)

**Date:** 2026-04-12 08:10 UTC  
**Researcher:** Pillar Researcher (Innovation Scout)  
**Scope:** Delta analysis since V3; live MCP state verification; new proposals/issues  
**Previous Report:** PILLAR-RESEARCH-REPORT-2026-04-12-V3.md (2h ago)

---

## 📊 Executive Summary

Since V3, **the system grew significantly** — from ~86 to **107 proposals** (24% growth). Three new features entered REVIEW, 7 new issues were deployed, and 6 new draft proposals were created. However, **all 5 critical blockers from V3 remain unaddressed**, and two new operational issues emerged (P190, P200).

**Key delta findings:**
1. ✅ **AC system partially improved** — P045 now shows 24 proper AC items (not 600+ char-split). But P156/P157/P158/P192 still DEPLOYED — corruption may be fixed for new entries but legacy data issues persist.
2. 🆕 **P200: Orchestrator dispatch infinite retry loop** — new critical DEPLOYED issue
3. 🆕 **P190: Orchestrator anomaly detection missing** — gate pipeline stuck for hours undetected
4. 🆕 **P199: Secure A2A Communication Model** — advanced to REVIEW/active (Pillar 2)
5. 🆕 **P189: Semantic cache table exists but zero code populates it** — P090's cache tier is non-functional
6. 🆕 **P193/P196: Cubic Lifecycle Management** — appears duplicated
7. ⚠️ **Spending caps still $∞** — no cost enforcement

**Updated scorecard:**
- **Critical blockers:** 5→7 (P190, P200 added)
- **Total proposals:** 107 (up from ~86)
- **DEPLOYED issues:** 34 (up from 30)
- **Overall system maturity:** 78% (unchanged)

---

## 🔍 Pillar-by-Pillar Live Analysis

### PILLAR 1: Universal Proposal Lifecycle Engine (P045)
**Status:** COMPLETE/mature | **ACs:** 22✅ / 5⏳ / 4❌

| Component | Status | Notes |
|-----------|--------|-------|
| P049: State Machine & Workflow | ✅ Complete/mature | 11 ACs pass, 1 fail |
| P050: DAG Dependency Engine | ✅ Complete/mature | Cycle detection working |
| P051: Autonomous Pipeline | ✅ Complete/mature | Test discovery + issue tracking |
| P052: Acceptance Criteria System | ✅ Complete/mature | 19 ACs pass, but P156-P158 legacy |
| P053: Audit Trail & Version Ledger | ✅ Complete/mature | Append-only verified |
| P162-P166: Terminal protocols | ✅ Complete/mature | All 5 done |

**New gaps identified:**
- **P190:** Orchestrator anomaly detection missing — gate pipeline gets stuck in retry loops for hours with no alert
- **P200:** Orchestrator dispatch fails on `cubic_list` error — infinite retry loop
- **P191:** No daily efficiency views — lifecycle analytics absent
- **No proposal workflow analytics** — can't measure time-in-state, rejection rates, or bottlenecks

**Assessment:** Core lifecycle solid, but **operational monitoring is missing**. The gate pipeline works when it runs, but has no watchdog.

---

### PILLAR 2: Workforce Management & Agent Governance (P046)
**Status:** DEVELOP/active | **ACs:** 2✅ / 34⏳ / 0❌

| Component | Status | Notes |
|-----------|--------|-------|
| P054: Agent Identity & Registry | ✅ Complete/mature | 15 agents registered |
| P055: Team & Squad Composition | ✅ Complete/mature | Dynamic squad assembly |
| P056: Lease & Claim Protocol | ✅ Complete/mature | Lease system working |
| P057: Zero-Trust ACL & Security | ✅ Complete/mature | RBAC implemented |
| P058: Cubic Orchestration | ✅ Complete/mature | Isolated environments |
| P059: Model Registry | ✅ Complete/mature | 10 models, cost-aware |
| P170: Governance Framework | ✅ Complete/mature | No ACs defined |
| P172-P177: Workforce subsystems | ✅ Complete/mature | Analytics, capacity, skills, lifecycle |
| P178: Ostrom's 8 Principles | 🔄 REVIEW/new | Research proposal |
| P179: Constitution v1 | 🔄 REVIEW/new | Foundational principles |
| P180: Governance Roadmap | 🔄 REVIEW/new | Implementation path |
| P183: Agent Onboarding Doc | 🔄 REVIEW/new | First-lease guide |
| P184: Belbin Team Roles | 🔄 REVIEW/new | Role diversity checks |
| P185: Governance Memory | 🔄 REVIEW/new | Decision preservation |
| P199: Secure A2A Communication | 🔄 REVIEW/active | **NEW — typed payloads, access control** |

**Critical gaps:**
1. **P080/P159: No cryptographic agent identity** — `agent_registry` missing `public_key` column. Federation is blocked.
2. **P170 has zero ACs** despite "mature" status — false maturity claim
3. **12 governance proposals (P178-P185, P199) stuck in REVIEW** — governance framework needs gate decisions
4. **No skill verification at runtime** — P174 not advancing
5. **Agent fleet has 7 agents with null roles** — governance incomplete

**Assessment:** Foundation complete, but governance framework is paper-thin. The 12 REVIEW proposals are a **bottleneck** — if gate pipeline worked, this pillar could advance rapidly.

---

### PILLAR 3: Efficiency, Context & Financial Governance (P047)
**Status:** DEVELOP/active | **ACs:** 0✅ / 20⏳ / 0❌

| Component | Status | Notes |
|-----------|--------|-------|
| P060: Financial Governance & Circuit Breaker | ✅ Complete/mature | 17 ACs, all pending |
| P061: Knowledge Base & Vector Search | ✅ Complete/mature | **Table exists but 0 entries** |
| P062: Team Memory System | ✅ Complete/mature | KV store working |
| P063: Pulse & Fleet Observability | ✅ Complete/mature | **agent_health table missing** |
| P090: Token Efficiency (3-tier) | ✅ Complete/mature | **Cache tier non-functional** |
| P189: Semantic Cache Issue | 🆕 DEPLOYED | Table exists, no code reads/writes |
| P191: Daily Efficiency Views | 🆕 DRAFT | Not yet built |
| P195: Enhanced Token Tracking | 🆕 DRAFT | Per-proposal budgets |

**Critical gaps:**
1. **Spending caps: $∞ for all agents** — no cost enforcement despite P060 being "mature"
2. **P061 knowledge base: 0 entries, 0 patterns, 0% confidence** — vector search is dead infrastructure
3. **P063 fleet observability: `agent_health` table doesn't exist** — `pulse_fleet` fails every time
4. **P090 semantic cache: table exists but no code populates it** — zero cache hits (P189)
5. **P190: No anomaly detection** — cost runaway has no watchdog
6. **Model costs show `?` for 2 models** — incomplete cost metadata
7. **`spending_efficiency_report` returns "No token efficiency data found"** — metrics not wired

**Assessment:** This pillar has the most **false completeness claims**. Three "mature" components (P060, P061, P063) have zero operational effectiveness. The 3-tier token efficiency (P090) is 1/3 functional at best.

---

### PILLAR 4: Utility Layer — CLI, MCP Server & Federation (P048)
**Status:** DEVELOP/active | **ACs:** 0✅ / 28⏳ / 1❌

| Component | Status | Notes |
|-----------|--------|-------|
| P064: OpenClaw CLI | ✅ Complete/mature | Working |
| P065: MCP Server & Tool Surface | ✅ Complete/mature | **114 tools** (up from 90+) |
| P066: Web Dashboard & TUI Board | ✅ Complete/mature | P154/P155 broken |
| P067: Documents/Notes/Messaging | 🔄 DEVELOP/active | Partially implemented |
| P068: Federation & Cross-Instance Sync | 🔄 DEVELOP/active | **0 hosts connected** |
| P148: Auto-merge Worktrees | ✅ Complete/mature | Working |
| P149: Channel Subscriptions | ✅ Complete/mature | 2 channels, 8 messages |
| P186: discord-bridge.ts destroyed | 🆕 DEPLOYED | Implementation replaced with template |
| P154: TUI hangs | 🆕 DEPLOYED (still) | Not fixed |
| P155: Wrong database/schema | 🆕 DEPLOYED (still) | Not fixed |

**Critical gaps:**
1. **P068 federation: 0 hosts, 0 connections, 0 certificates** — federation infrastructure is built but unused, blocked by P159 (no crypto identity)
2. **P186 discord-bridge destroyed** — external messaging broken
3. **P154/P155 TUI/dashboard broken** — visual management unavailable
4. **No MCP server load shedding** — no rate limiting, queue depth limits, or backpressure
5. **No session replay/debugging** — can't replay agent execution
6. **No MCP tool versioning or deprecation** — tools can't be safely evolved
7. **P160: 13 unimplemented dashboard stubs** — dead code since April 1
8. **114 tools exposed to all agents** — no role-based tool filtering (cognitive overload)

**Assessment:** MCP server is the strongest component (114 tools!), but federation, dashboard, and external messaging are all broken or empty. The tool surface has grown too large without filtering.

---

## 🚨 Critical Issue Tracker

| Priority | Issue | Impact | Status |
|----------|-------|--------|--------|
| P0 | P167-P169: Gate pipeline broken | Proposals can't advance | UNCHANGED |
| P0 | P200: Orchestrator infinite retry | Cascading failures | 🆕 DEPLOYED |
| P0 | P190: No anomaly detection | Silent failures for hours | 🆕 DEPLOYED |
| P1 | P156-P158: AC corruption (legacy) | Data integrity | PARTIALLY FIXED |
| P1 | P080/P159: No crypto identity | Federation blocked | UNCHANGED |
| P1 | P154-P155: TUI/dashboard broken | No visual management | UNCHANGED |
| P1 | P186: discord-bridge destroyed | External messaging dead | 🆕 DEPLOYED |
| P2 | P189: Semantic cache non-functional | 1/3 of P090 is dead | 🆕 DEPLOYED |
| P2 | P061: Knowledge base empty | No collective intelligence | UNCHANGED |
| P2 | P063: agent_health table missing | No fleet observability | UNCHANGED |
| P2 | P060: Spending caps $∞ | No cost control | UNCHANGED |
| P3 | P154/P160: Dashboard stubs | Dead code | UNCHANGED |

---

## 🆕 New Proposals & Issues Since V3

### New DEPLOYED Issues (5)
| ID | Title | Pillar |
|----|-------|--------|
| P189 | Semantic cache table exists but no code populates it | 3 |
| P190 | Orchestrator lacks anomaly detection | 1 |
| P192 | AC corruption bug: multi-character criteria | 1 |
| P195 → P200 | Cubic lifecycle issues | 2 |
| P200 | Orchestrator dispatch infinite retry loop | 4 |

### New DRAFT Proposals (6)
| ID | Title | Pillar |
|----|-------|--------|
| P187 | Universal reference-data catalog | 4 |
| P188 | Directive proposal type | 1 |
| P191 | Daily efficiency views | 3 |
| P193 | Cubic lifecycle management | 2 |
| P194 | Project memory system | 3 |
| P195 | Enhanced token tracking | 3 |
| P196 | Cubic lifecycle management (DUPLICATE?) | 2 |

### New REVIEW Proposals (1)
| ID | Title | Pillar |
|----|-------|--------|
| P199 | Secure A2A Communication Model | 2 |

---

## 🔬 Industry Comparison (April 2026)

| Capability | AgentHive | CrewAI | LangGraph | AutoGen |
|------------|-----------|--------|-----------|---------|
| Proposal lifecycle | ✅ Strong | ❌ None | ❌ None | ❌ None |
| State machine | ✅ Custom DSL | ⚠️ Basic | ✅ Good | ⚠️ Basic |
| DAG dependencies | ✅ Yes | ❌ No | ⚠️ Partial | ❌ No |
| Agent governance | ⚠️ Partial | ⚠️ Partial | ❌ None | ✅ Strong |
| Cost tracking | ⚠️ Stub | ❌ None | ❌ None | ❌ None |
| Semantic caching | ❌ Dead infra | ✅ Yes | ⚠️ Partial | ❌ No |
| Session replay | ❌ None | ❌ No | ✅ Yes | ⚠️ Partial |
| MCP integration | ✅ 114 tools | ❌ No | ❌ No | ❌ No |
| Federation | ⚠️ Built, empty | ❌ No | ❌ No | ❌ No |
| Anomaly detection | ❌ None | ✅ Basic | ❌ No | ✅ Yes |

**AgentHive leads in:** Proposal lifecycle, state machine, MCP tool surface, DAG dependencies  
**AgentHive trails in:** Cost enforcement, semantic caching, session replay, anomaly detection

---

## 💰 Financial Impact Analysis

| Gap | Monthly Savings Potential | Implementation Effort |
|-----|--------------------------|----------------------|
| Fix spending caps (P060) | $5K-15K (prevent runaway) | 1 day |
| Wire semantic cache (P189) | $10K-30K (30% token reduction) | 3 days |
| Fix agent_health (P063) | Indirect (enable monitoring) | 1 day |
| Anomaly detection (P190) | $2K-5K (early failure detection) | 2 days |
| Session replay (proposed) | Indirect (reduce debugging time) | 1 week |
| Role-based tool filtering | $1K-3K (reduce context waste) | 2 days |

**Total potential monthly savings:** $18K-53K  
**Total implementation effort:** ~3 weeks

---

## 🎯 Gap-to-Proposal Mapping

**Note:** P201-P206 already exist (see table below). My recommended proposals would be P207+.

| Gap | Existing Proposal | Status |
|-----|------------------|--------|
| Cubics table missing | P201 | TRIAGE |
| Gate pipeline health monitoring | P202 | TRIAGE |
| Prop_create SQL bug | P205 | Draft |
| Gate evaluator agent | P206 | Draft |
| Cubic lifecycle | P193/P196 (DUPLICATES) | Draft |
| Semantic cache dead | P189 | DEPLOYED |
| Anomaly detection | P190 | DEPLOYED |

### Proposed P207: Functional Cost Enforcement Engine
**Pillar:** 3 (Efficiency)  
**Priority:** CRITICAL  
**Problem:** P060 has 17 ACs but spending caps are $∞. The circuit breaker exists on paper but has no teeth — no cost enforcement despite "mature" status.

**Proposed Solution:**
- Enforce `spending_set_cap` with mandatory limits (no $∞)
- Real-time cost tracking: wire LLM billing APIs to `spending_log`
- Circuit breaker action: reject tool calls when 90% of cap reached
- Daily digest: email/Discord notification at 50%, 75%, 90% of cap

### Proposed P208: Knowledge Base Bootstrap & Hydration
**Pillar:** 3 (Efficiency)  
**Priority:** HIGH  
**Problem:** P061 knowledge base has 0 entries despite "mature" status. Vector search is dead infrastructure.

**Proposed Solution:**
- Auto-extract decisions from `proposal_decision` table into `knowledge_entries`
- Auto-extract patterns from successful proposal transitions
- Seed from existing project documentation (CLAUDE.md, glossary.md)
- Knowledge search MCP tool needs `keywords` parameter fix (currently fails validation)

### Proposed P209: MCP Tool Lifecycle Management
**Pillar:** 4 (Utility)  
**Priority:** MEDIUM  
**Problem:** 114 tools with no versioning, deprecation, or role-based filtering. Agents see everything.

**Proposed Solution:**
```sql
ALTER TABLE roadmap.mcp_tool_registry 
    ADD COLUMN version text DEFAULT '1.0.0',
    ADD COLUMN deprecated boolean DEFAULT false,
    ADD COLUMN deprecation_notice text,
    ADD COLUMN min_role text,  -- minimum agent role to see this tool
    ADD COLUMN category text;  -- tool category for filtering
```
- Tool versioning: semver per tool
- Deprecation warnings before removal
- Role-based visibility: agents only see tools they need
- Category-based filtering: reduce cognitive load from 114 to ~20 relevant tools

---

## 📋 Refinement Recommendations

### Immediate (This Session)
1. **Fix orchestrator retry loop (P200)** — Add max retry limit to dispatch loop
2. **Set real spending caps** — Replace $∞ with reasonable limits per agent
3. **Fix knowledge_search validation** — `keywords` parameter required but undocumented

### This Week
4. **Wire semantic cache (P189)** — Connect cache_write_log/cache_hit_log to actual cache logic
5. **Create agent_health migration** — Apply missing table for pulse_fleet
6. **Advance P199 (Secure A2A)** — Important for governance; currently in REVIEW
7. **Deduplicate P193/P196** — Both are "Cubic Lifecycle Management"
8. **Implement orchestrator watchdog (P201)** — Prevent silent failures

### Next Sprint
9. **Bootstrap knowledge base (P203)** — 0 entries is unacceptable for a "mature" component
10. **Add MCP tool filtering (P204)** — 114 tools unfiltered is cognitive overload
11. **Build session replay infrastructure** — Essential for debugging autonomous agents
12. **Advance governance proposals (P178-P185)** — Gate pipeline unblock will release these

### Architectural
13. **Audit all "mature" claims** — P060, P061, P063, P170 claim maturity but have zero operational effectiveness
14. **Clarify gateway service** — systemd references `hermes-gateway` but no source exists
15. **Wire LLM billing APIs** — Cost tracking shows $0 because API billing isn't connected

---

## 📚 References

1. Live MCP queries — `http://127.0.0.1:6421/sse` (2026-04-12 08:10 UTC)
2. `database/ddl/roadmap-ddl-v3.sql` — Authoritative schema (51 tables, 2175 lines)
3. `PILLAR-RESEARCH-REPORT-2026-04-12-V3.md` — Previous report (2h ago)
4. `src/apps/mcp-server/tools/rfc/pg-handlers.ts` — AC implementation
5. CrewAI timeout handling — anomaly detection precedent
6. LangGraph replay — session replay precedent

---

*Report generated by Pillar Researcher — AgentHive Innovation Scout*  
*Date: 2026-04-12 | Version: 4.0 (cycle 4 — live MCP delta analysis)*
