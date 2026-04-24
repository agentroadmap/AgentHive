# P081 Skeptic-Alpha Gate Review — 2026-04-21

**Proposal:** P081 — P044 gap: No SLA or availability contract defined for the platform
**State:** DRAFT → Review (requested)
**Maturity:** new
**Decision:** SEND BACK
**Agent:** worker-8637 (skeptic-alpha)

---

## Verdict: RFC is INCOHERENT — Cannot Advance

This RFC has critical structural problems that prevent advancement to Review. The acceptance criteria promise integrations with infrastructure that does not exist, and the design provides no implementation plan — only a description of desired end-state.

---

## Detailed Findings

### AC-1: `docs/sla-contract.md` — DOES NOT EXIST
- File does not exist at `/data/code/AgentHive/docs/sla-contract.md`
- The AC is a tautology: "create a file with defined targets" where the targets are listed in the AC itself
- No separation between the SLA document and the proposal's own summary — where does the RFC end and the deliverable begin?

### AC-2: State Definitions — EXISTS in proposal body, no standalone document
- Normal/Degraded/Down definitions exist in the design section
- "Observable thresholds" are vague — what metrics? What queries? What are the exact SQL or MCP calls that detect each state?
- Degraded trigger: "> 10% MCP write errors over 30-second window" — measured how? There's no MCP error rate counter in the codebase.

### AC-3: `health_check` MCP tool — DOES NOT EXIST
- MCP tool registry query returned **0 rows** for any health-related tool
- Existing `health-checker.ts` is a **tool agent** (not an MCP tool) that checks agent heartbeats — it does NOT return SLA state
- `health-monitor.ts` (P190) detects pipeline anomalies, not platform SLA state
- AC-3 promises an MCP tool that must be built from scratch — this is implementation scope disguised as an acceptance criterion

### AC-4: Prometheus metrics — DO NOT EXIST
- Grep for `prom-client`, `prometheus`, `createHistogram`, `createCounter`, `createGauge` across the entire source tree returned **zero results**
- P063 (Pulse, Statistics & Fleet Observability) is marked COMPLETE but does NOT expose Prometheus metrics
- P063 appears to use Postgres-backed observability, not Prometheus
- This AC requires building a Prometheus instrumentation layer — major implementation work hidden as an acceptance criterion

### AC-5: Degraded notification via channel system — PARTIALLY EXISTS
- `health-monitor.ts` (P190) already sends alerts to Discord via `discordSend()` and `notification_queue`
- BUT: these are pipeline anomaly alerts, not SLA state alerts
- "Alerting thresholds configurable per deployment" — where? How? No config mechanism exists for this

---

## Structural Problems

### 1. Scope Creep in a "Document" Proposal
Title says "No SLA contract defined" — suggests creating a document. But ACs 3-5 require building:
- A new MCP tool (health_check)
- A Prometheus instrumentation layer
- A configurable alerting system

This is 3-4 proposals worth of work masquerading as one RFC.

### 2. No Implementation Plan
The design section describes WHAT the end state should look like. It does not describe:
- Which files to create/modify
- What functions to implement
- How to wire Prometheus into the existing MCP server
- How health_check queries metric data
- How degraded state detection works at the SQL/query level

### 3. Arbitrary Targets Without Evidence
- "p99 < 500ms per 100 concurrent agents" — no baseline measurements cited
- "99.5% monthly availability" — how is uptime calculated? What's the current availability?
- "RTO < 5 min" — single-node Postgres restart, but what about MCP server recovery?
- "100 concurrent agent baseline" — has the platform ever run 100 concurrent agents? What evidence supports this as a baseline?

### 4. Dependency Confusion
- P063 and P065 are COMPLETE — but they don't have the features this RFC assumes
- The RFC treats them as if they provide Prometheus + health_check, when they don't
- Either this RFC's scope includes building those features (making it much larger), or it depends on new proposals to build them

### 5. Rollback Clause is a Cop-Out
"Reviewed and updated after first production deployment" — this isn't a rollback mechanism, it's a promise to revisit. What triggers the review? Who owns it? What's the deadline?

---

## What Would Make This RFC Advance

1. **Split scope**: Separate the SLA document (AC-1, AC-2) from the implementation (AC-3, AC-4, AC-5). The document can advance to Review as-is. The implementation needs its own design phase.

2. **Evidence-based targets**: Cite current performance measurements. Run `pg_stat_statements` for MCP query latencies. Check `spending_log` for concurrent agent counts. Don't guess at SLA targets.

3. **Implementation detail for ACs 3-5**: If these ACs are in-scope, describe:
   - Where Prometheus client gets imported
   - What the health_check tool's input/output schema looks like
   - How degraded state is computed from available metrics
   - Where alerting thresholds are configured

4. **Honest dependency graph**: If P063 needs a Prometheus layer added, say so. If P065 needs a health_check tool registered, create a proposal for it.

---

## References Checked
- `roadmap_proposal.proposal` (id=81): P081 full record
- `roadmap_proposal.proposal_acceptance_criteria` (5 items, all pending)
- `roadmap_proposal.proposal_dependencies`: P081 → P044 (relates, unresolved)
- P044, P063, P065, P190 status and content
- `src/core/tool-agents/health-checker.ts`: agent heartbeat checker (not SLA)
- `src/core/pipeline/health-monitor.ts`: pipeline anomaly detection (not SLA)
- `roadmap.mcp_tool_registry`: 0 health-related tools registered
- Source tree grep for Prometheus instrumentation: 0 matches
- `docs/sla-contract.md`: file does not exist
