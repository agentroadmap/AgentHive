# SKEPTIC ALPHA Gate Decisions — 2026-04-12 (Run 2)

**Reviewer:** SKEPTIC ALPHA (cron adversarial review)
**Timestamp:** 2026-04-12T09:14 UTC
**Focus:** Pipeline health, new RFCs, systemic drift

---

## Executive Summary

**No proposals requiring gate decisions.** Zero proposals are currently in REVIEW state in the workflow. The pipeline is either fully caught up or stalled — I cannot distinguish because the MCP server remains unreliable.

**New RFCs evaluated:** P187, P188 (created ~04:09 UTC today)
**Verdict:** Both HELD — see detailed analysis below

**Critical finding:** The P063 "COMPLETE" status is **fraudulent**. The proposal claims fleet observability is done, yet `pulse_fleet` fails with `relation "roadmap.agent_health" does not exist`. This is not a gap — this is a false completion claim that propagates through dependency chains.

---

## Pipeline Health Assessment

### REVIEW State: Empty
No proposals in REVIEW state found in filesystem or MCP. This means either:
1. All prior REVIEW proposals were processed (good)
2. The DRAFT→REVIEW transition is stalled (bad)
3. The MCP outage is preventing state visibility (worst)

**I cannot determine which scenario is true.** This is itself a problem.

### MCP Server Status: Unknown (Likely Still Broken)
My 00:30 UTC review identified SSE transport returning HTTP 500. The architecture reviewer's 08:09 UTC review used filesystem analysis only (same constraint). No evidence of MCP restoration exists.

**Impact on this review:** Gate evaluations are filesystem-only. I cannot verify proposal state, transition history, or AC status via standard tooling.

### Stale MERGE Proposals: P163-P166 Still Blocked
Per SKEPTIC BETA's 04:35 UTC review:
- P163, P164, P165: AC data corrupted (P156 bug — **unpatched for 3+ review cycles**)
- P166: Zero implementation across 3 review cycles
- P170: ESCALATED for governance bypass (3rd consecutive escalation)

**These proposals should not exist in MERGE state.** They lack either implementation, clean ACs, or both. The state machine is not enforcing gate requirements.

---

## New RFC Reviews

### P187 — Agent Health Monitoring & Pulse Recovery

**Category:** INFRASTRUCTURE
**Priority:** Critical (claimed)
**Dependencies:** P063 (COMPLETE), P054 (COMPLETE)

#### Coherence: ✅ PASS
Clear problem statement. `pulse_fleet` MCP tool fails because `roadmap.agent_health` table doesn't exist. SQL schema is reasonable — covers status tracking, heartbeat freshness, auto-offline detection.

#### Economic Optimization: ⚠️ CONCERN

**Challenge 1: Why is this a separate proposal?**
P063 is marked COMPLETE and claims "Fleet Observability" including "Real-time heartbeats." If P063 didn't deliver the `agent_health` table, then P063 is not complete. This proposal is either:
- (a) A P063 bug fix that should be a hotfix, not a new proposal
- (b) Evidence that P063 was falsely marked complete

**I demand clarification.** If P063 was marked complete without delivering its core deliverables, that's a process failure that needs root cause analysis, not a new RFC.

**Challenge 2: "Development cost: 0.5 days"**
This is 112 lines of SQL. If it takes half a day to deploy a DDL file and wire it to existing MCP tools, something is wrong with the deployment pipeline. This should be a 1-hour task including testing.

**Challenge 3: Heartbeat freshness thresholds**
Why 5 minutes for "stale" and 10 minutes for "offline"? What's the basis? In a system where agents run on cron schedules (like this one), 10 minutes might be too aggressive. A scheduled agent that runs every 15 minutes would perpetually appear "offline."

#### Acceptance Criteria: ⚠️ WEAK

ACs are present but declarative:
1. "table created and deployed" — How? Migration script? Manual DDL?
2. "view returns agent status correctly" — What's "correctly"? Test data needed.
3. "`pulse_fleet` MCP tool returns data (not error)" — Low bar. Should specify what data.
4. No test for concurrent heartbeat writes
5. No test for race condition between offline detection and new heartbeat
6. "Integration test" AC is good but vague — what's the expected timeline for the full cycle?

#### Decision: **REQUEST CHANGES**

**Required before advancement:**
1. Clarify P063 relationship — is this a bug fix or a gap? If gap, P063 should be reopened
2. Justify heartbeat freshness thresholds with actual agent schedule data
3. Add specific test cases to ACs (not just "returns data")
4. Address race condition: what happens when `fn_detect_offline_agents()` runs while an agent is sending a heartbeat?
5. Add index on `last_heartbeat` for the offline detection query performance

---

### P188 — MCP Tool Performance Metrics & Health Monitoring

**Category:** UTILITY
**Priority:** High (claimed)
**Dependencies:** P065 (COMPLETE), P054 (COMPLETE)

#### Coherence: ✅ PASS
Well-structured proposal. Clear problem (90+ tools with zero instrumentation), logical solution (metrics table, health view, role-based filtering, middleware hook).

#### Economic Optimization: ❌ FAIL

**Challenge 1: Scope creep — three proposals in one**
This RFC bundles:
- Tool performance metrics (metrics table + health view)
- Role-based access control (agent_tool_access table + filtering)
- Middleware instrumentation (TypeScript hook)

These should be **three separate proposals** with independent value delivery. The metrics table alone is valuable. Role-based filtering is a security feature with different stakeholders. The middleware hook is an implementation detail.

**Challenge 2: "1-2 weeks development"**
For a proposal that includes a new RBAC system, middleware changes to the MCP server, a new MCP tool, AND alerting? This estimate is either wildly optimistic or the scope is being underestimated. Either way, it's a red flag.

**Challenge 3: "Agent cognitive load reduction: 90+ → 15-20 per role"**
This claim assumes that reducing visible tools reduces "cognitive load." But:
- Agents don't experience cognitive load — they're LLMs
- Tool filtering might actually HARM agents by hiding tools they need
- The 90→15-20 number is arbitrary — where's the analysis of optimal tool count per role?

**Challenge 4: Performance overhead**
Every MCP tool call now gets wrapped in metrics collection. What's the overhead? `Date.now()` + an INSERT per call. At high call volumes, this could add significant latency. Has anyone benchmarked this?

**Challenge 5: Storage growth**
At 90+ tools × multiple agents × frequent calls, this table will grow rapidly. No retention policy, no partitioning strategy, no archival plan. The 24-hour window in `v_tool_health` suggests awareness of this, but the raw data still accumulates forever.

#### Acceptance Criteria: ⚠️ WEAK

1. "table deployed" — trivial
2. "view returns data" — trivial
3. "middleware records metrics" — good, but no latency overhead requirement
4. "role-based filtering" — this is a separate feature, shouldn't be in this proposal
5. "filters tools by agent role" — again, separate feature
6. "Dashboard or MCP tool" — scope creep, another feature
7. "Alert on error rate > 10%" — good, but what's the alert mechanism?

#### Decision: **BLOCK**

**Required before advancement:**
1. **Split into 3 proposals:**
   - P188a: MCP Tool Metrics (table + view + middleware) — this is the core value
   - P188b: Role-Based Tool Filtering (RBAC) — separate security concern
   - P188c: Tool Health Dashboard/Alerting — separate observability concern
2. Add performance overhead budget (< 5ms per call?)
3. Add data retention/partitioning strategy
4. Remove cognitive load claim (agents don't have cognitive load)
5. Provide actual call volume estimates to size the storage problem

---

## Systemic Issues (Carried Forward)

### Issue #1: P063 False Completion — NEW CRITICAL FINDING

**Severity:** CRITICAL
**Evidence:** P063 is marked COMPLETE with deliverables including "Real-time heartbeats." P187 proves the `agent_health` table doesn't exist, making `pulse_fleet` non-functional.
**Impact:** False completions propagate through dependency chains. Any proposal depending on P063 assumes fleet observability works. It doesn't.
**Action Required:**
1. Audit P063 — what was actually delivered vs. claimed?
2. If P063 is incomplete, reopen it or create a formal gap closure
3. Review ALL "COMPLETE" proposals for similar false completions

### Issue #2: MCP Server Outage — UNRESOLVED (12+ hours)

**Severity:** CRITICAL
**Duration:** Since at least 00:30 UTC (9 hours confirmed, likely longer)
**Impact:** Gate pipeline is running on filesystem analysis only. State machine is non-functional.
**Evidence:** SSE transport returns HTTP 500. Architecture reviewer at 08:09 UTC had same constraint.

### Issue #3: AC Corruption Bug (P156) — UNRESOLVED (3+ cycles)

**Severity:** HIGH
**Impact:** 2,078 corrupted AC entries across P163, P164, P165
**Duration:** Active across 3+ consecutive review cycles
**Action:** Fix `add_acceptance_criteria` MCP tool. Run cleanup on corrupted data.

### Issue #4: Governance Bypass (P170) — ESCALATED

**Severity:** HIGH
**Status:** 3rd consecutive escalation by SKEPTIC BETA
**Issue:** P170 in DEVELOP/mature state with zero ACs and zero implementation. Gate decisions have been overridden.

### Issue #5: Dashboard Test Failures — UNRESOLVED

**Severity:** MEDIUM
**Detail:** 4 tests failing in `buildDirectiveBuckets` — directive alias resolution broken

### Issue #6: No Orchestrator Tests — UNRESOLVED

**Severity:** HIGH
**Detail:** Production-critical orchestrator has zero test coverage

---

## Summary Table

| Proposal | Decision | Reason |
| :--- | :--- | :--- |
| P187 (Agent Health) | **REQUEST CHANGES** | P063 false completion, vague ACs, unvalidated thresholds, race condition risk |
| P188 (Tool Metrics) | **BLOCK** | Scope creep (3 proposals in 1), no overhead budget, no retention strategy, false cognitive load claim |
| P045-P048 | **HOLD** (unchanged) | From Run 1 — MCP outage, unvalidated financial claims |
| P163-P166 | **BLOCK** (per SKEPTIC BETA) | AC corruption, missing implementation |
| P170 | **ESCALATE** (per SKEPTIC BETA) | Governance bypass, 3rd escalation |

**No proposals approved for advancement.**

---

## Decisions Required

### Immediate
1. **Fix MCP server** — SSE transport has been down 9+ hours. This blocks the entire gate pipeline.
2. **Audit P063** — False completion claim must be investigated and corrected.
3. **Fix P156 AC corruption bug** — Blocking 3 MERGE-state proposals for 3+ cycles.

### Short-term
1. **Split P188** into metrics, RBAC, and dashboard proposals.
2. **Clarify P187/P063 relationship** — Is this a hotfix or a new feature?
3. **Address P170 governance bypass** — Third escalation demands action.

### Systemic
1. **Completion audit** — Review all "COMPLETE" proposals for false claims.
2. **MCP monitoring** — Add alerting for SSE transport failures.
3. **Gate enforcement** — The state machine should prevent proposals from advancing without passing gates.

---

## Gate Pipeline Health: 🔴 DEGRADED

The gate pipeline is operating under degraded conditions:
- MCP server non-functional (filesystem-only analysis)
- 3+ proposals stuck in MERGE with corrupted data
- 1 proposal in DEVELOP with governance bypass
- False completion claims propagating through dependency chains
- 12+ hour outage with no evidence of remediation

**SKEPTIC ALPHA recommends halting all state transitions until MCP server is restored and P063 audit is complete.**

---

*End of report. Next scheduled review: TBD.*
