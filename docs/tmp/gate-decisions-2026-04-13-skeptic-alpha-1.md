# SKEPTIC ALPHA Gate Decisions — 2026-04-13 (Run 1)

**Reviewer:** SKEPTIC ALPHA (cron adversarial review)
**Timestamp:** 2026-04-13T00:21 UTC
**Focus:** REVIEW-state proposals, infrastructure health, carry-forward systemic issues

---

## Executive Summary

**🔴 CRITICAL: AgentHive is non-functional.** The entire Postgres database schema is missing — zero tables exist. ALL MCP tools backed by Postgres (`prop_list`, `workflow_list`, `agent_list`, `knowledge_*`, `cubic_list`, `escalation_*`, `chan_list`, `memory_*`) return `relation does not exist` errors. The proposal workflow cannot be evaluated because **the proposal table itself does not exist**. Systemd services (`hermes-gate-pipeline`, `hermes-orchestrator`, `hermes-gateway`) are all inactive. This is not a proposal-level problem — it is a **platform-level catastrophe** that must be resolved before any gate decisions can be made.

---

## Gate Decisions

| Proposal | Decision | Primary Reason |
| :--- | :--- | :--- |
| **ALL PROPOSALS** | **🔴 BLOCKED (INFRA)** | Database schema not applied — cannot enumerate, evaluate, or transition any proposal |

No individual proposal reviews can proceed. The review pipeline is broken at the foundation.

---

## Critical Findings

### Finding 1: Complete Database Schema Missing — Severity: CRITICAL

**Evidence:**
- `prop_list` → `relation "proposal" does not exist`
- `workflow_list` → `relation "workflow_templates" does not exist`
- `agent_list` → `relation "agent_registry" does not exist`
- `knowledge_get_stats` → `relation "knowledge_entries" does not exist`
- `cubic_list` → `relation "roadmap.cubics" does not exist`
- `escalation_stats` → `relation "roadmap.escalation_log" does not exist`
- `chan_list` → `relation "message_ledger" does not exist`
- `memory_list` → `relation "v_active_memory" does not exist`

**Tables required by MCP tools but missing:**
- `proposal` (core — all proposal operations)
- `workflow_templates` (workflow engine)
- `agent_registry` (agent identity)
- `knowledge_entries` (knowledge base)
- `roadmap.cubics` (cubic orchestration)
- `roadmap.escalation_log` (obstacle tracking)
- `message_ledger` (A2A messaging)
- `v_active_memory` (agent memory view)
- `proposal_state_transitions` (RFC schema)
- `proposal_discussions` (RFC schema)
- `proposal_acceptance_criteria` (AC tracking)

**Schema files exist at:**
- `/data/code/AgentHive/roadmap/schema/rfc-schema.sql` (RFC workflow tables)
- `/data/code/AgentHive/roadmap/docs/dataModel/schema_v2.1.ddl` (master schema)

**Impact:** The entire AgentHive proposal lifecycle is non-functional. No proposals can be listed, created, reviewed, transitioned, or tracked. The MCP server is running but serving 100% error responses on Postgres-backed tools.

**Required Action:** Apply the database schema immediately. Verify Postgres is running, create the required tables from the schema files, and verify MCP tools resolve correctly.

---

### Finding 2: All Systemd Services Down — Severity: CRITICAL

**Evidence:**
```
$ systemctl status hermes-gate-pipeline
Unit hermes-gate-pipeline.service could not be found.
$ systemctl status hermes-orchestrator
Unit hermes-orchestrator.service could not be found.
$ systemctl status hermes-gateway
Unit hermes-gateway.service could not be found.
```

**Impact:** Even if the database schema were applied:
- **Gate pipeline** — proposals cannot transition between states (the automated gate enforcement is dead)
- **Orchestrator** — no agent dispatch, no cubic spawning, no event-driven workflows
- **Gateway** — no external API access, no webhook delivery

**Required Action:** Reinstall and start all three systemd services. Verify they connect to Postgres successfully.

---

### Finding 3: MCP Server Running in Degraded Mode — Severity: HIGH

**Evidence:** The MCP server at `http://127.0.0.1:6421/sse` responds and lists 100+ tools, but:
- File-based tools work (`document_list` returns results)
- ALL Postgres-backed tools fail with `relation does not exist`

The server is running but effectively useless for the core workflow. Only document management and some roadmap.md operations function.

**Required Action:** Either the MCP server should detect and report degraded mode, or the Postgres connection should be validated on startup with clear error reporting.

---

## Carry-Forward Systemic Issues (from SKEPTIC BETA)

These issues were flagged across 6 consecutive SKEPTIC BETA review cycles (April 12) and remain unresolved:

### CF-1: Node.js v24 TypeScript Compatibility — ESCALATED

- `knowledge/handlers.ts` line 17: `constructor(private readonly server: McpServer) {}` crashes with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
- 65 files in `src/` use `private readonly` pattern
- Integration tests that touch MCP knowledge tools are ALL blocked
- **6 consecutive reviews**, same blocker, **trivial fix** (15 min work)
- **Verdict:** This is now a governance failure. Two fixes exist: refactor constructors OR pin Node.js v22.

### CF-2: Orchestrator Zero Test Coverage — BLOCKED

- `scripts/orchestrator.ts` — production-critical infrastructure
- New cubic reuse logic (297 lines) — zero tests
- Code quality improved (proper try/catch/finally) but unverified

### CF-3: proposal-storage-v2.ts — UNCHANGED (3rd cycle)

- 870 lines, only 3/25 functions with error handling
- Zero test coverage
- `tags: any` type safety violation
- This is a **core persistence layer** — database connection failures will crash the MCP server

### CF-4: P163, P164, P165, P166 — ALL STILL BLOCKED

| Proposal | Status | Blocker |
| :--- | :--- | :--- |
| P163 (Effective Blocking Protocol) | BLOCK | ACs corrupted, no dedicated tests |
| P164 (Briefing Assembler) | BLOCK | Zero implementation evidence |
| P165 (Cycle Resolution Protocol) | BLOCK | Weakest-link scoring not implemented |
| P166 (Terminal State Protocol) | BLOCK | No schema column, no implementation |

---

## Structural Observations

### Schema Version Confusion

Multiple schema definitions exist with conflicting designs:
- `schema_v2.1.ddl` — "FRESH START" design with `proposal`, `proposal_version`, `proposal_criteria` (uses BIGINT PKs, no display_id normalization)
- `rfc-schema.sql` — RFC workflow extension that **references `proposal(id)` as FK** but assumes the table already exists
- `rfc-workflow-v1.sql` — yet another version

**Question:** Which schema is canonical? Has ANY of these been applied to the production database? The answer appears to be **none**.

### Document-Based Fallback vs. Postgres Reality

The MCP server appears to have a dual-storage design:
- **Roadmap.md files** — used by `document_*` tools (working)
- **Postgres tables** — used by `prop_*`, `workflow_*`, `knowledge_*` tools (broken)

The system appears to have been mid-migration from file-based to Postgres storage. The migration is incomplete and both paths are inconsistent.

---

## Recommendations

### Immediate Actions (P0 — Platform is Down)

1. **Verify Postgres is running** and accessible
2. **Apply the database schema** — determine which DDL is canonical and execute it
3. **Verify all MCP tools** resolve after schema application
4. **Reinstall systemd services** (`hermes-gate-pipeline`, `hermes-orchestrator`, `hermes-gateway`)
5. **Smoke-test the proposal workflow** end-to-end (create → draft → review → develop)

### Strategic (P1 — Prevent Recurrence)

1. **Schema migration tooling** — the `agenthive-db-migration` skill exists but apparently hasn't been used. Make schema application part of deployment.
2. **MCP startup health check** — the server should refuse to start (or clearly warn) when Postgres tables are missing
3. **Fix Node.js v24 compatibility** — 6 cycles is unacceptable. Pin Node v22 or fix the TypeScript pattern.
4. **Add orchestrator tests** — production infrastructure without tests is a liability

### For Gary (Human Owner)

The AgentHive platform has been non-functional since the database was last reset or never initialized. All the sophisticated tooling (100+ MCP tools, gate pipeline, orchestrator, knowledge base) exists in code but has no backend. This needs manual intervention — the automated agents cannot fix this themselves because the tools they would use to coordinate require the database that doesn't exist.

---

## Gate Pipeline Health: 🔴 CRITICAL FAILURE

| Component | Status | Detail |
| :--- | :--- | :--- |
| MCP Server | 🟢 Running | Responds at localhost:6421 |
| Postgres Schema | 🔴 Missing | ALL tables absent |
| Gate Pipeline (systemd) | 🔴 Down | Service not found |
| Orchestrator (systemd) | 🔴 Down | Service not found |
| Gateway (systemd) | 🔴 Down | Service not found |
| Proposal Workflow | 🔴 Broken | Cannot list/create/transition proposals |
| Review Pipeline | 🔴 Broken | Cannot submit reviews (needs proposal table) |

**The gate cannot operate.** SKEPTIC ALPHA cannot evaluate proposals that cannot be enumerated from a database that doesn't exist.

---

*Report generated by SKEPTIC ALPHA — adversarial design review agent*
*Next action: Human intervention required to restore platform infrastructure*
