# 📊 Pillar Research Report — 2026-04-13
**Researcher:** Pillar Researcher (Cron Job)
**Scope:** Cross-pillar gap analysis, industry benchmarking, component proposals
**Previous Report:** [2026-04-12 Ecosystem Analysis](./RESEARCH-2026-04-12-4-pillar-ecosystem-analysis.md)

---

## Executive Summary

Day-over-day status: **No material change** from the April 12 report. The core structural issues persist — gate pipeline remains broken, governance proposals stuck in REVIEW, semantic cache unimplemented, federation at 0 hosts. However, this research adds **industry benchmarking data** and **prioritized component proposals** that weren't in the prior report.

**Key Metrics:**
| Pillar | Spec Coverage | Implementation | Operational |
|--------|--------------|----------------|-------------|
| P045 — Proposal Lifecycle | 95% | 70% | ❌ Gate pipeline dead |
| P046 — Workforce Mgmt | 80% | 45% | ❌ 0 teams, null roles |
| P047 — Efficiency/Finance | 75% | 15% | ❌ No cache, no routing |
| P048 — Utility Layer | 85% | 60% | ⚠️ MCP strong, rest partial |

**Spec-to-Code Ratio: ~3:1** — Excellent specifications exist but implementation lags badly.

---

## PILLAR 1: Universal Proposal Lifecycle Engine (P045)

### Industry Benchmarking
Compared against: **LangGraph** (stateful graphs), **Temporal** (durable workflows), **CrewAI Flows** (event-driven).

| Feature | Industry Standard | AgentHive | Gap |
|---------|------------------|-----------|-----|
| Durable execution / crash recovery | LangGraph checkpointer, Temporal saga | `pipeline-cron.ts` (polling loop) | 🔴 No durable execution engine |
| Event-driven triggers | CrewAI `@listen()`, Temporal signals | Polling-based cron | 🔴 Misses real-time transitions |
| Human-in-the-loop | LangGraph `interrupt()` API | Briefing Assembler (P164) | 🟡 Exists but untested |
| Conditional branching | LangGraph `add_conditional_edges()` | SMDL condition blocks | 🟡 Spec exists, no parser |
| Subgraph composition | LangGraph subgraphs | Cubic isolation | 🟡 Cubics work but aren't composable |

### Gap Analysis

**🔴 CRITICAL: Gate Pipeline (P151/P152/P167-169)**
- Still non-functional. PipelineCron not running.
- This is the **single largest blocker** in the entire platform.
- Industry reference: Temporal's workflow engine runs as a service with guaranteed execution. AgentHive's equivalent is a broken cron poller.

**🟡 HIGH: Missing Workflow Templates**
- Only 3 templates exist (RFC-5, Quick-Fix, Code Review).
- Industry standard (CrewAI, Temporal): 10+ templates covering incident response, feature development, research sprints, hotfixes, migration workflows.
- CLAUDE.md defines 5 proposal types but only 2 workflow variants (Standard RFC + Hotfix).

**🟡 HIGH: SMDL Parser Not Built**
- 330-line YAML specification exists, zero parser code.
- LangGraph achieves the same with Python decorators — AgentHive's YAML approach is more flexible but inert.

**🟡 MEDIUM: AC Corruption Bugs (P156/P157/P158/P192)**
- Acceptance criteria data corruption persists (character splitting).
- Undermines the entire RFC Standard.

### Component Proposals

1. **Workflow Template Library** — Create 7 additional templates:
   - `Feature-Development` (5-stage with AC gates)
   - `Incident-Response` (3-stage: Triage → Mitigate → Postmortem)
   - `Research-Sprint` (4-stage: Scope → Investigate → Synthesize → Archive)
   - `Migration` (4-stage: Plan → Migrate → Validate → Cleanup)
   - `Security-Audit` (4-stage with mandatory skeptic review)
   - `Dependency-Update` (2-stage: Test → Merge)
   - `Architecture-RFC` (5-stage with extended review)

2. **SMDL Parser Implementation** — Build `smdl-loader.ts` that:
   - Parses YAML workflow definitions into `workflow_*` tables
   - Validates against schema constraints
   - Supports hot-reload of workflow definitions

3. **Gate Pipeline Health Monitor** — Standalone health check that:
   - Detects pipeline-cron failures within 60 seconds
   - Auto-restarts with backoff
   - Reports metrics to `agent_health` table

---

## PILLAR 2: Workforce Management & Agent Governance (P046)

### Industry Benchmarking
Compared against: **OpenAI Agents SDK** (guardrails), **AutoGen/MAF** (composable agents), **CrewAI** (role-based teams).

| Feature | Industry Standard | AgentHive | Gap |
|---------|------------------|-----------|-----|
| Agent roles with backstories | CrewAI (Role+Goal+Backstory) | `agent_registry.role` column | 🔴 7/17 agents have null roles |
| Guardrails / input validation | OpenAI Agents SDK | ACL table exists | 🟡 Table exists, no enforcement |
| Teams / squads | CrewAI Crews, AutoGen groups | `team` table | 🔴 0 teams despite complete status |
| Agent reputation | Custom scoring in most platforms | `skill_certification` (P174) | 🟡 Spec only |
| Agent-as-tool composition | OpenAI Agents SDK, AutoGen | Cubic spawning | 🟡 Cubics exist, no composability |
| Constitutional enforcement | Constitutional AI (Anthropic) | Constitution v1 (P179) | 🔴 Stuck in REVIEW |
| Crypto identity / trust | JWT/API keys in most | P080/P159 proposals | 🔴 Not implemented |

### Gap Analysis

**🔴 CRITICAL: Zero Operational Teams**
- `team_list` returns "No teams found" despite P055 being marked COMPLETE.
- This means the entire workforce management pillar has no organizational structure.
- Industry platforms (CrewAI, AutoGen) require team composition as a prerequisite for agent collaboration.

**🔴 CRITICAL: Null Roles Break Access Control**
- 7/17 registered agents have `role: null`.
- Role-based access control cannot function without roles.
- CrewAI's pattern: `Agent(role="Senior Researcher", goal="...", backstory="...")` — every agent has a defined role.

**🟡 HIGH: Governance Proposals Stuck in REVIEW**
- P179 (Constitution v1), P178 (Ostrom's 8 Principles), P180 (Governance Roadmap), P184 (Belbin Team Roles) — all in REVIEW.
- Without governance enforcement, AgentHive is an ungoverned agent population.
- Ostrom's 8 Principles (G001 adoption): only 2/8 have any implementation.

**🟡 HIGH: No Agent Health Monitoring**
- `agent_health` table not in any DDL.
- `pulse_health` and `pulse_fleet` MCP tools fail.
- Industry standard: continuous heartbeats, latency tracking, error rates.

**🟡 MEDIUM: Missing Crypto Identity**
- P080/P159 propose public key infrastructure for agent identity.
- Without this, agent-to-agent trust is purely honor-system.

### Component Proposals

1. **Team Seeding Script** — Auto-create foundational teams:
   - `architecture-team` (Pillar Leads, Skeptics)
   - `development-team` (Builders, Testers)
   - `review-team` (Reviewers, Gatekeepers)
   - `operations-team` (Ops, Monitors)

2. **Role Enforcement Middleware** — Validate `agent_registry.role` on every MCP call:
   - Reject operations from null-role agents
   - Map roles to capability sets
   - Audit log for unauthorized access attempts

3. **Agent Health Table + Monitor** — Add to DDL:
   ```sql
   CREATE TABLE agent_health (
     agent_id TEXT PRIMARY KEY REFERENCES agent_registry(id),
     last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
     status TEXT CHECK (status IN ('healthy','degraded','offline','dead')),
     avg_latency_ms INTEGER,
     error_rate NUMERIC(5,4),
     proposals_completed INTEGER DEFAULT 0,
     updated_at TIMESTAMPTZ DEFAULT NOW()
   );
   ```

4. **Governance Acceleration Sprint** — Fast-track P179/P178 through gate:
   - Constitution v1 is foundational — blocking everything else in P046
   - Ostrom principles need at least 6/8 implemented for meaningful governance

---

## PILLAR 3: Efficiency, Context & Financial Governance (P047)

### Industry Benchmarking
Compared against: **vLLM** (inference optimization), **LangChain caching** (semantic cache), **prompt caching APIs** (OpenAI, Anthropic).

| Feature | Industry Standard | AgentHive | Gap |
|---------|------------------|-----------|-----|
| Semantic cache | GPTCache, LangChain (30% savings) | `token_cache` spec | 🔴 Table not in DDL, zero code |
| Prompt caching | OpenAI/Anthropic native APIs | Spec in P090 | 🔴 Not implemented |
| Context compaction | LangGraph state management | No code found | 🔴 Not implemented |
| Model routing | LiteLLM, multi-LLM routers | `multi-llm-router.ts` exists | 🟡 Code exists, rules empty |
| Cost tracking | Langfuse, OpenLLMetry | `spending_log` table | 🟡 Table exists, 0 data |
| Loop detection | LangGraph cycle detection | `loop_detection_config` spec | 🔴 Table not in DDL |
| Token counting | tiktoken, model-aware | `context_window_log` table | 🟡 Table exists, unpopulated |

### Gap Analysis

**🔴 CRITICAL: Semantic Cache — Zero Implementation**
- The 3-tier cost reduction architecture (P090) is AgentHive's most ambitious efficiency feature.
- **Tier 1 (Semantic Cache):** `token_cache.semantic_responses` table not in any DDL. No code.
- **Tier 2 (Prompt Caching):** No integration with OpenAI/Anthropic prompt caching APIs.
- **Tier 3 (Context Management):** No compaction, no summarization, no window tracking.
- Industry benchmark: GPTCache + prompt caching can achieve 60-80% cost reduction.
- **Impact:** AgentHive is paying full price for every LLM call.

**🔴 CRITICAL: Model Routing Rules — Empty**
- `model_routing_rules` table referenced in P047 but **not in DDL**.
- `multi-llm-router.ts` (21K) exists with routing logic but no rules to route by.
- Without routing rules, every task gets the default model regardless of complexity.

**🟡 HIGH: Knowledge Base — Nearly Empty**
- Only 4 entries, 0 patterns.
- The knowledge base is supposed to enable pattern reuse across sessions.
- Without patterns, every agent starts from scratch.

**🟡 MEDIUM: Loop Detection Missing**
- `loop_detection_config` table not in DDL.
- Agents can retry indefinitely without detection.
- LangGraph has built-in cycle detection; AgentHive should too.

### Component Proposals

1. **DDL Migration: Missing Efficiency Tables** — Add to roadmap-ddl-v4:
   ```sql
   CREATE TABLE token_cache (
     id SERIAL PRIMARY KEY,
     prompt_hash TEXT NOT NULL,
     model_id TEXT NOT NULL,
     semantic_embedding vector(1536),
     response TEXT NOT NULL,
     tokens_saved INTEGER,
     hit_count INTEGER DEFAULT 0,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     expires_at TIMESTAMPTZ
   );

   CREATE TABLE model_routing_rules (
     id SERIAL PRIMARY KEY,
     task_type TEXT NOT NULL,
     complexity TEXT CHECK (complexity IN ('low','medium','high','critical')),
     model_id TEXT NOT NULL REFERENCES model_assignment(id),
     max_tokens INTEGER,
     priority INTEGER DEFAULT 0,
     enabled BOOLEAN DEFAULT true
   );

   CREATE TABLE loop_detection_config (
     id SERIAL PRIMARY KEY,
     agent_id TEXT REFERENCES agent_registry(id),
     max_retries INTEGER DEFAULT 3,
     cooldown_seconds INTEGER DEFAULT 60,
     circuit_breaker_threshold INTEGER DEFAULT 5,
     circuit_breaker_window INTEGER DEFAULT 300
   );
   ```

2. **Semantic Cache Implementation** — Build `semantic-cache.ts`:
   - Embed incoming prompts with pgvector
   - Check cosine similarity against cached responses (threshold: 0.95)
   - Return cached response if match found
   - Estimated savings: 20-30% of token spend

3. **Model Routing Rules Seeder** — Populate routing rules:
   - `simple_lookup` → fast/cheap model
   - `code_generation` → capable model with moderate context
   - `architecture_review` → most capable model, extended context
   - `gating_decision` → most capable model, full context

4. **Token Efficiency Dashboard** — Wire existing tables to MCP tools:
   - Real-time cost per proposal
   - Cache hit rate
   - Model utilization breakdown
   - ROI of semantic cache

---

## PILLAR 4: Utility Layer — CLI, MCP Server & Federation (P048)

### Industry Benchmarking
Compared against: **MCP SDK v2** (protocol evolution), **Dapr** (distributed building blocks), **A2A Protocol** (cross-framework communication).

| Feature | Industry Standard | AgentHive | Gap |
|---------|------------------|-----------|-----|
| MCP tool versioning | Proposed in MCP v2 | `mcp_tool_registry` (no version columns) | 🔴 Not implemented |
| Tool metrics / observability | OpenTelemetry, Langfuse | `mcp_tool_metrics` spec | 🔴 Table not in DDL |
| Role-based tool scoping | OpenAI function calling ACL | `mcp_tool_assignment` exists | 🟡 Table exists, partial |
| Federation | Dapr service mesh, A2A protocol | `federation-server.ts` (36K) | 🟡 Code exists, 0 hosts |
| Service discovery | Dapr naming, Consul | Not implemented | 🔴 Missing |
| Health checks | K8s liveness probes, Dapr health | No MCP health endpoint | 🔴 Missing |
| Streamable HTTP | MCP v2 (replacing SSE) | SSE only | 🟡 Will need migration |
| Cubic management | K8s pods, Dapr actors | Cubic MCP tools | 🔴 `cubics` table missing from DDL |

### Gap Analysis

**🔴 CRITICAL: Cubics Table Missing from DDL**
- Cubic Orchestration (P058) is marked COMPLETE in CLAUDE.md.
- But the `cubics` table is **not in any DDL file**.
- Cubic MCP tools will fail on any operation requiring the table.

**🔴 CRITICAL: MCP Tool Versioning — Not Implemented**
- P048 proposes `api_version`, `deprecated`, `sunset_at` columns.
- `mcp_tool_registry` exists in DDL but without versioning columns.
- Without versioning, tool changes break agent integrations silently.

**🟡 HIGH: Federation at 0 Hosts**
- `federation-server.ts` (36K) and `federation-pki.ts` (22K) exist.
- But `federation_stats` shows 0 connected hosts.
- No service discovery, no auto-registration, no health-based routing.

**🟡 HIGH: MCP Tool Metrics Missing**
- P188 proposes `mcp_tool_metrics` table for usage tracking.
- Table not in DDL.
- Without metrics, cannot identify slow/failing/unpopular tools.

**🟡 MEDIUM: CLI Type Case Mismatch (P143/P144)**
- Persistent type errors in CLI commands.
- Low severity but annoying for agent operators.

### Component Proposals

1. **DDL Migration: Missing Utility Tables**
   ```sql
   CREATE TABLE cubics (
     id TEXT PRIMARY KEY,
     proposal_id TEXT REFERENCES proposals(id),
     worktree_path TEXT,
     agent_slots INTEGER DEFAULT 3,
     resource_budget JSONB,
     status TEXT CHECK (status IN ('provisioning','active','draining','terminated')),
     created_at TIMESTAMPTZ DEFAULT NOW(),
     terminated_at TIMESTAMPTZ
   );

   CREATE TABLE mcp_tool_metrics (
     id SERIAL PRIMARY KEY,
     tool_name TEXT NOT NULL,
     call_count INTEGER DEFAULT 0,
     avg_latency_ms INTEGER,
     error_count INTEGER DEFAULT 0,
     last_called TIMESTAMPTZ,
     period_start TIMESTAMPTZ NOT NULL,
     period_end TIMESTAMPTZ NOT NULL
   );

   ALTER TABLE mcp_tool_registry
     ADD COLUMN api_version TEXT DEFAULT '1.0.0',
     ADD COLUMN deprecated BOOLEAN DEFAULT false,
     ADD COLUMN sunset_at TIMESTAMPTZ,
     ADD COLUMN description TEXT;
   ```

2. **Federation Bootstrapper** — Auto-discovery and registration:
   - mDNS/DNS-SD for local discovery
   - Config-based registration for remote hosts
   - Health-based routing with automatic failover

3. **MCP Tool Versioning Middleware** — Enforce API compatibility:
   - Check `api_version` before tool calls
   - Warn on deprecated tools
   - Block calls to sunset tools
   - Log version mismatches

4. **MCP Health Endpoint** — Add `/health` to MCP server:
   - Database connectivity
   - Tool registration count
   - Active agent count
   - Federation host count
   - Uptime and version

---

## Cross-Pillar Analysis

### Dependency Graph
```
P045 (Lifecycle) ──blocks──→ ALL
   └── Gate pipeline dead = no automated advancement

P046 (Workforce) ──blocks──→ P045 (gating needs agents)
   └── 0 teams, null roles = no governance

P047 (Efficiency) ──independent──→ Can be built in parallel
   └── Missing tables = immediate DDL work

P048 (Utility) ──blocks──→ P046 (federation needs hosts)
   └── Missing cubics table = cubic tools broken
```

### Priority Ranking (Data-Driven)

| Priority | Issue | Pillar | Impact | Effort | Score |
|----------|-------|--------|--------|--------|-------|
| **P0** | Fix gate pipeline | P045 | 🔴 Critical | Medium | **100** |
| **P1** | Add missing DDL tables | ALL | 🔴 Critical | Low | **95** |
| **P2** | Seed teams + enforce roles | P046 | 🔴 Critical | Low | **90** |
| **P3** | Implement semantic cache | P047 | 🟡 High | Medium | **80** |
| **P4** | Fast-track governance (P179) | P046 | 🟡 High | Medium | **75** |
| **P5** | Build SMDL parser | P045 | 🟡 High | Medium | **70** |
| **P6** | Populate model routing rules | P047 | 🟡 High | Low | **65** |
| **P7** | Federation bootstrapper | P048 | 🟡 Medium | High | **50** |
| **P8** | MCP tool versioning | P048 | 🟡 Medium | Medium | **45** |

### Recommended Sprint Plan

**Sprint 1 (Immediate — unblock the platform):**
1. Fix gate pipeline (P151/P152/P167-169)
2. Add missing DDL tables (cubics, agent_health, token_cache, model_routing_rules, loop_detection_config, mcp_tool_metrics)
3. Seed foundational teams + enforce non-null roles

**Sprint 2 (Efficiency — stop bleeding tokens):**
1. Implement semantic cache tier 1
2. Populate model routing rules
3. Wire token efficiency dashboard

**Sprint 3 (Governance — establish order):**
1. Fast-track Constitution v1 (P179) through gate
2. Implement Ostrom principles enforcement
3. Build agent health monitoring

**Sprint 4 (Polish — production readiness):**
1. SMDL parser implementation
2. MCP tool versioning
3. Federation bootstrapper
4. Additional workflow templates

---

## Industry References

1. **LangGraph** — Stateful graph-based agent orchestration with durable checkpointer (LangChain, 2024-2026)
2. **Temporal + OpenAI Agents SDK** — Durable workflow engine for agent orchestration (Temporal, 2025-2026)
3. **CrewAI** — Role-based agent teams with event-driven Flows (CrewAI, 2024-2026)
4. **AutoGen → Microsoft Agent Framework** — Composable agent tool architecture (Microsoft, 2024-2026)
5. **OpenAI Agents SDK** — Guardrails, handoffs, agent-as-tool patterns (OpenAI, 2025-2026)
6. **Dapr** — Distributed application runtime with pub/sub, workflows, actors (CNCF, 2019-2026)
7. **MCP Specification v2** — Streamable HTTP transport, tool versioning (Anthropic, 2025-2026)
8. **A2A Protocol** — Cross-framework agent communication (Google, 2025-2026)
9. **Ostrom's 8 Principles** — Governance of common-pool resources (Elinor Ostrom, 1990)
10. **Belbin Team Roles** — Team composition diversity framework (Meredith Belbin, 1981)

---

*Report generated by Pillar Researcher cron job. Next run: scheduled cycle.*
