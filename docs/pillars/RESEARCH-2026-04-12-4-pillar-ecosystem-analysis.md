# 🔍 AgentHive 4-Pillar Ecosystem Research Report
**Date:** 2026-04-12 | **Researcher:** Pillar Researcher (Cron)
**Scope:** Gap analysis, component proposals, and refinement recommendations

---

## Executive Summary

AgentHive has **210+ proposals** across its 4 pillars. Pillar 1 (Proposal Lifecycle) is **COMPLETE/Mature** with strong foundations but broken gate pipeline. Pillars 2-4 are in **DEVELOP/Active** with significant gaps between spec and implementation. The most critical finding: **the gate pipeline — the engine that moves proposals through the lifecycle — is non-functional** (P151, P152, P167-169).

---

## PILLAR 1: Universal Proposal Lifecycle Engine (P045) — COMPLETE ✅

### Current State
| Component | Status | Notes |
|-----------|--------|-------|
| State Machine (5-stage) | ✅ Mature | Draft→Review→Develop→Merge→Complete |
| Maturity Model (4-level) | ✅ Mature | New→Active→Mature→Obsolete |
| Configurable Workflow Engine | 📋 Spec Only | RFC-5, Quick-Fix templates designed but not implemented |
| State Machine DSL | 📋 Spec Only | YAML-based SMDL defined, not coded |
| DAG Dependency Engine (P050) | ✅ Complete | Cycle detection, dependency ordering |
| Acceptance Criteria (P052) | ✅ Complete | But bugs P156/P157/P158/P192 corrupt AC data |
| Proposal Storage (P053) | ✅ Complete | Audit trail, version ledger |
| Briefing Assembler (P164) | ✅ Complete | Context assembly before decisions |

### 🔴 CRITICAL GAPS

**1. Gate Pipeline is BROKEN (P151, P152, P167-169)**
- PipelineCron gate worker not running
- MCP server doesn't initialize gate pipeline at startup
- Gate pipeline rubber-stamps transitions without rationale
- Skeptic decisions fail to record (missing 'actor' column)
- spawnAgent fails with 'Not logged in'
- **Impact:** Proposals cannot advance automatically. The entire state machine is manual.

**2. Configurable Workflow Engine — Spec Only**
- 5 new tables designed (workflow_templates, workflows, workflow_stages, workflow_transitions, workflow_roles)
- Quick-Fix template (3-stage) designed but not seeded
- `workflow_load` and `workflow_load_builtin` MCP tools exist but may not be wired correctly
- **Gap:** Users cannot create custom workflows today

**3. State Machine DSL — Not Implemented**
- Full YAML spec (330 lines) exists for workflow definitions
- No parser/loader code found in src/
- **Gap:** Workflows are hardcoded, not declarative

### Recommendations
1. **PRIORITY 1:** Fix gate pipeline (P151/P152/P167-169) — this blocks all automated lifecycle progression
2. Implement configurable workflow engine tables + seed RFC-5 and Quick-Fix templates
3. Build SMDL loader to parse YAML workflow definitions into workflow_* tables
4. Fix AC corruption bugs (P156/P157/P158/P192)

---

## PILLAR 2: Workforce Management & Agent Governance (P046) — DEVELOP 🔨

### Current State
| Component | Status | Notes |
|-----------|--------|-------|
| Agent Identity & Registry (P054) | ✅ Complete | Workforce registry with roles |
| Team & Squad Composition (P055) | ✅ Complete | Dynamic squad assembly |
| Lease & Claim Protocol (P056) | ✅ Complete | Proposal leasing model |
| Zero-Trust ACL (P057) | ✅ Complete | Security access controls |
| Agent Society Governance (P170) | ✅ Complete | Constitution, laws, conventions |
| Performance Analytics (P172) | ✅ Complete | Agent benchmarking |
| Capacity Planning (P173) | ✅ Complete | Demand forecasting |
| Skill Certification (P174) | ✅ Complete | Reputation ledger |
| Retirement & Lifecycle (P175) | ✅ Complete | Knowledge transfer |
| Labor Market (P176) | ✅ Complete | Talent exchange |
| Ostrom's 8 Principles (P178) | 📋 REVIEW | Governance mapping |
| Constitution v1 (P179) | 📋 REVIEW | Foundational principles |
| Governance Roadmap (P180) | 📋 REVIEW | Implementation plan |
| Belbin Team Roles (P184) | 📋 REVIEW | Diversity checking |
| Governance Memory (P185) | 📋 REVIEW | Cross-session rationale |
| A2A Communication (P199) | 📋 REVIEW | Typed payloads, ACL |
| Agent Authorization (P207-209) | 📋 DRAFT | Decision signing, trust model |
| Crash Recovery (P210) | 📋 DRAFT | Handover protocol |

### 🟡 GAPS IDENTIFIED

**1. No Formal Amendment Process (P181)**
- Constitution exists but no mechanism to change it
- Governance rules are static

**2. No Team-Level Governance (P182)**
- Only individual agent and society levels
- Missing squad/team-level governance layer

**3. Agent Identity: No Cryptographic Binding (P080/P159)**
- String-handle impersonation risk
- `agent_registry` missing `public_key` column
- No cryptographic agent identity for federated deployments

**4. A2A Messaging Lacks Security Model (P199)**
- No typed payloads
- No access control on inter-agent messages
- No targeted delivery guarantees

**5. Missing: Agent Onboarding (P183 in REVIEW)**
- No formal document for new agents to read before first lease
- Institutional knowledge transfer is ad-hoc

### Recommendations
1. Implement cryptographic agent identity (P080/P159) — critical for federation
2. Advance Ostrom/Constitution proposals from REVIEW to DEVELOP
3. Build team-level governance layer
4. Implement A2A security model with typed payloads
5. Create formal onboarding protocol with constitutional knowledge

---

## PILLAR 3: Efficiency, Context & Financial Governance (P047) — DEVELOP 🔨

### Current State
| Component | Status | Notes |
|-----------|--------|-------|
| Token Efficiency 3-Tier (P090) | ⚠️ Partial | Schema exists, code doesn't populate cache |
| Model Registry & Routing (P059) | ✅ Complete | Cost-aware model selection |
| Financial Governance (P060) | ✅ Complete | Circuit breaker, spending caps |
| Knowledge Base (P061) | ✅ Complete | pgvector semantic search |
| Team Memory (P062) | ✅ Complete | Session-persistent KV store |
| Fleet Observability (P063) | ✅ Complete | Heartbeats, spending correlation |
| Daily Efficiency View (P191) | 📋 DRAFT | Combined metrics |
| Enhanced Token Tracking (P195) | 📋 DRAFT | Per-proposal budget breaker |
| Project Memory System (P194) | 📋 DRAFT | Structured context for cache |

### 🔴 CRITICAL GAPS

**1. Semantic Cache Table Exists But UNUSED (P189)**
- `token_cache.semantic_responses` table designed with pgvector
- No code to populate or read from it
- **Zero cache hits** — the primary cost reduction mechanism is dead
- Three-tier architecture (semantic cache → prefix cache → context management) only has Tier 2 partially working

**2. Memory Architecture Not Implemented**
- 4-layer design (Constitutional→Team→Project→Task) documented
- Only L4 (session/task) partially exists via agent_memory table
- L1-L3 layers are concepts, not tables

**3. No Rate Limiting on Messaging**
- No cap on messages/second per agent
- No queue depth limits
- No message priority system
- No digest mode for bulk messages
- "Gilbert problem" — noise flooding channels

**4. Context Window Management Missing**
- No tracking of context window utilization %
- No cache hit rate measurement (target: 70%+)
- No write/read ratio monitoring
- No "context anxiety" detection

### Recommendations
1. **PRIORITY 1:** Implement semantic cache read/write (P189) — biggest cost saver
2. Build 4-layer memory architecture tables
3. Add message rate limiting and priority system
4. Implement context window instrumentation
5. Build daily efficiency dashboard (P191)

---

## PILLAR 4: Utility Layer — CLI, MCP Server & Federation (P048) — DEVELOP 🔨

### Current State
| Component | Status | Notes |
|-----------|--------|-------|
| OpenClaw CLI (P064) | ✅ Complete | Command interface |
| MCP Server & Tools (P065) | ✅ Complete | 80+ MCP tools |
| Web Dashboard & TUI (P066) | ✅ Complete | Board, cockpit views |
| Federation & Sync (P068) | 🔨 DEVELOP | Cross-instance sync |
| Document/Messaging (P067) | 🔨 DEVELOP | Notes, documents, channels |
| Auto-Merge Worktrees (P148) | ✅ Complete | Worktree→main merge |
| Cubic Orchestration (P058) | ✅ Complete | Isolated execution envs |

### 🔴 CRITICAL GAPS

**1. Cubics Table Missing (P201)**
- `roadmap.cubics` table doesn't exist
- All cubic MCP tools fail
- Cubic lifecycle management (P193/P196) in DRAFT

**2. Federation Not Complete (P068)**
- Cross-instance sync in DEVELOP
- Cross-branch DAG resolution conflicts (P079)
- No cryptographic identity for federation (P080)

**3. Discord Bridge Destroyed (P186)**
- Commit 73a505c replaced implementation with template
- External notification channel broken

**4. Reference-Data Catalog Not Built (P087/P188)**
- Design exists (P088) but implementation (P187) in DRAFT
- Enums scattered across codebase
- No centralized vocabulary

**5. CLI Issues (P143/P144)**
- Help text lists wrong proposal types and maturity values
- Proposal create fails on type case mismatch

### Recommendations
1. **PRIORITY 1:** Create roadmap.cubics table — unblocks cubic tools
2. Fix CLI type/maturity case mismatches
3. Implement reference-data catalog
4. Restore discord-bridge.ts
5. Advance federation with cryptographic identity

---

## Cross-Pillar Systemic Issues

### 1. Gate Pipeline Collapse
**Affects:** All 4 Pillars
The entire automated lifecycle depends on the gate pipeline. Currently broken:
- P151: PipelineCron not running
- P152: MCP doesn't initialize gate pipeline
- P167: Rubber-stamping without rationale
- P168: Missing audit column
- P169: Agent spawning fails
- P204: Case mismatch in SQL function
- P205: SQL bug in prop_create
- P202: No health monitoring

**Recommendation:** Create a dedicated gate-pipeline-fix initiative (5-7 proposals) to restore automated lifecycle.

### 2. Schema Drift
**Affects:** Pillars 1, 4
- Legacy `maturity` JSONB vs new `maturity_state` TEXT (P086/P087)
- `proposal_valid_transitions` vs `workflow_transitions` dual-table confusion
- Case sensitivity issues (REVIEW vs Review)

### 3. Spec-vs-Implementation Gap
Many components have excellent specifications but no implementation:
- Configurable Workflow Engine (spec: 212 lines, code: 0)
- State Machine DSL (spec: 330 lines, code: 0)
- Semantic Cache (spec: in P090, code: 0)
- 4-Layer Memory (spec: documented, code: 0)

---

## New Component Proposals

### PP-001: Gate Pipeline Health Monitor
**Pillar:** 1 (Proposal Lifecycle)
**Priority:** CRITICAL
- Health check endpoint for gate pipeline
- Automatic restart on failure
- Alert on stuck proposals (>4h without transition)
- Metrics: transitions/hour, gate decision latency

### PP-002: Workflow Template Library
**Pillar:** 1
**Priority:** HIGH
- Seed RFC-5, Quick-Fix, Enterprise templates
- MCP tools: workflow_clone, workflow_edit, workflow_validate
- Template marketplace concept

### PP-003: Semantic Cache Implementation
**Pillar:** 3
**Priority:** CRITICAL
- Populate token_cache.semantic_responses on LLM calls
- Lookup before every API call (threshold: 0.92 cosine similarity)
- Cache warming for common patterns
- Metrics: hit rate, cost saved

### PP-004: 4-Layer Memory Tables
**Pillar:** 3
**Priority:** HIGH
- agent_constitution (L1: global, permanent)
- team_memory (L2: team-scoped, long-term)
- project_memory (L3: project-scoped, medium-term) — rename agent_memory
- Retain local files for L4 (session/task)

### PP-005: Message Rate Limiter
**Pillar:** 3
**Priority:** MEDIUM
- Per-agent: max 10 messages/minute
- Per-channel: max 500 unread messages
- Priority field: urgent/normal/low
- Digest mode: batch notifications

### PP-006: Cubic Lifecycle Manager
**Pillar:** 4
**Priority:** HIGH
- Create roadmap.cubics table
- Idle detection (>30min = idle)
- Auto-cleanup of stale cubics
- Resource limit enforcement (CPU, memory, tokens)

### PP-007: Cryptographic Agent Identity
**Pillar:** 2
**Priority:** HIGH (blocks federation)
- Add public_key column to agent_registry
- Ed25519 key pair generation on registration
- Signature verification on A2A messages
- Identity binding for federated instances

### PP-008: Reference Data Catalog
**Pillar:** 4
**Priority:** MEDIUM
- Centralize proposal types, maturity levels, categories
- MCP tools: catalog_list, catalog_validate
- Auto-generate TypeScript enums from catalog

---

## Prioritized Action Plan

| Priority | Action | Proposals | Pillars |
|----------|--------|-----------|---------|
| P0 | Fix gate pipeline | P151, P152, P167-169, P204, P205 | 1 |
| P1 | Implement semantic cache | PP-003 | 3 |
| P1 | Create cubics table | P201, PP-006 | 4 |
| P1 | Cryptographic agent identity | P080, P159, PP-007 | 2, 4 |
| P2 | Build configurable workflow engine | Spec → Implementation | 1 |
| P2 | 4-layer memory architecture | PP-004 | 3 |
| P2 | Fix AC corruption bugs | P156, P157, P158, P192 | 1 |
| P3 | Message rate limiting | PP-005 | 3 |
| P3 | Reference data catalog | P187, PP-008 | 4 |
| P3 | Restore discord bridge | P186 | 4 |

---

## Industry Best Practices Applied

1. **Harness Engineering** (from Pillar 4 docs): Structural constraints > prompt engineering. Gate pipeline = harness.
2. **Least Agency Model** (from Pillar 2 docs): Reader agents separate from Actor agents. Currently not enforced.
3. **Three-Tier Cost Reduction** (from Pillar 3 docs): Semantic→Prefix→Context. Only Tier 2 partially works.
4. **Ostrom's 8 Principles** (P178): Common-pool resource governance for agent society. In REVIEW, needs advancement.
5. **DAG-based Dependency Management** (P050): Complete and working — best-in-class for proposal ordering.

---

*Report generated by Pillar Researcher — 2026-04-12 22:07 UTC*
