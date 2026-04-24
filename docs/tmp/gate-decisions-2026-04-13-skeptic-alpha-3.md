# SKEPTIC ALPHA Gate Decisions — 2026-04-13 (Run 3)

**Reviewer:** SKEPTIC ALPHA (cron adversarial review)
**Timestamp:** 2026-04-13T03:18 UTC
**Focus:** REVIEW-state proposals, pipeline health, systemic governance proposal cascade

---

## Executive Summary

**7 proposals in REVIEW state. All 7 BLOCKED.** This is not a coincidence — it is a systemic failure. Every single governance proposal was pushed to REVIEW with zero formal acceptance criteria, wrong type classification, and no dependencies registered. The "governance sprint" produced research docs masquerading as features, with no measurable success conditions.

**Primary finding:** A batch of 7 proposals was auto-advanced from DRAFT to REVIEW (by `system` agent, timestamps show ~2-minute intervals) without any gate rigor. This is the exact failure mode P150 warned about — `prop_update` bypasses Decision Gate evaluation entirely.

---

## Gate Decisions

| Proposal | Decision | Primary Reason |
| :--- | :--- | :--- |
| P178 — Ostrom's 8 Principles | **BLOCK** | Zero ACs, type mismatch (research→component) |
| P179 — Constitution v1 | **BLOCK** | Zero ACs, premature, endorsed architecture REJECT |
| P180 — Governance Roadmap | **BLOCK** | Zero ACs, 4 unregistered dependencies, type mismatch |
| P183 — Agent Onboarding | **BLOCK** | Zero ACs, depends on rejected P179, premature |
| P184 — Belbin Role Coverage | **BLOCK** | Zero ACs, unvalidated hypothesis for LLM agents |
| P185 — Governance Memory | **BLOCK** | Zero ACs, redundant with existing systems |
| P199 — Secure A2A Communication | **BLOCK** | Zero ACs, 3 architecture options with no selection rationale |

---

## Critical Findings

### Finding 1: Zero Acceptance Criteria — 7/7 Proposals — CRITICAL

**Every proposal in REVIEW has zero formal acceptance criteria.** This is the single most common and most preventable gate failure. The `list_ac` tool returns "No acceptance criteria" for all 7.

**Why this matters:** Without ACs, there is no objective measure of whether work is done. These proposals will enter DEVELOP, agents will produce code/documents, and nobody will know if it's correct. The gate pipeline cannot enforce "AC: all" transitions without registered ACs.

**Root cause:** The proposals were batch-advanced from DRAFT→REVIEW by the `system` agent without AC enhancement. This is a workflow failure — the DRAFT→REVIEW transition should require AC registration as a precondition.

**Evidence:**
- P178 AC: "No acceptance criteria for 178"
- P179 AC: "No acceptance criteria for 179"
- P180 AC: "No acceptance criteria for 180"
- P183 AC: "No acceptance criteria for 183"
- P184 AC: "No acceptance criteria for 184"
- P185 AC: "No acceptance criteria for 185"
- P199 AC: "No acceptance criteria for 199"

### Finding 2: Type Misclassification — 7/7 Proposals — HIGH

**All proposals are typed as `feature` (Type B — Implementation), but the majority are research documents or design artifacts (Type A — Design).**

| Proposal | Current Type | Correct Type | Reason |
| :--- | :--- | :--- | --- |
| P178 — Ostrom's 8 Principles | feature | component | Research document mapping frameworks. Produces markdown, not code. |
| P179 — Constitution v1 | feature | component | Constitutional document. Design artifact, no implementation. |
| P180 — Governance Roadmap | feature | component | Implementation roadmap. Planning document, not code. |
| P183 — Agent Onboarding | feature | component | Documentation. Prose document, no tests. |
| P184 — Belbin Role Coverage | feature | feature | **Correctly typed** — this actually requires orchestrator code changes. |
| P185 — Governance Memory | feature | feature | **Correctly typed** — requires storage implementation. |
| P199 — A2A Communication | feature | feature | **Correctly typed** — requires code implementation. |

**Impact:** Wrong type = wrong gate evaluation criteria. Type A proposals are evaluated on design coherence, not code correctness. Forcing them through Type B gates wastes development resources on proposals that should be design-reviewed first.

### Finding 3: Gate Bypass — Batch Auto-Advance by System Agent — CRITICAL

**Timeline evidence:**
- P183: Created 2026-04-11T15:08:45Z, advanced to REVIEW 2026-04-11T15:21:32Z (13 min)
- P184: Created 2026-04-11T15:08:45Z, advanced to REVIEW 2026-04-11T15:21:35Z (13 min)
- P185: Created 2026-04-11T15:08:45Z, advanced to REVIEW 2026-04-11T15:21:39Z (13 min)

All three were created by `system` and advanced by `system` within seconds of each other. No gate evaluation occurred. This is the P150 bypass in action — `prop_update` with status field circumvents Decision Gate entirely.

**This undermines the entire gate pipeline.** If `system` can batch-advance proposals, the skeptic's gate role is decorative.

### Finding 4: Premature Proposals — P179, P183, P184 — HIGH

These proposals build on infrastructure that doesn't exist:

- **P179 (Constitution):** Defines rights and obligations, but the enforcement mechanisms don't exist. The gate pipeline can't even record decisions (P167/P168 broken), so "constitutional governance" is aspirational fiction.
- **P183 (Onboarding):** Depends on the constitution (P179 — REJECTED). Cannot write onboarding for governance that doesn't exist.
- **P184 (Belbin):** Applies human corporate team role theory to LLM agents with zero evidence of applicability. What is a "Plant" LLM? What is a "Completer Finisher" bot? This is cargo-culting human organizational theory without adaptation.

### Finding 5: Unregistered Dependencies — P180 — MEDIUM

P180's text references P167, P168, P169, P178, P179 as dependencies. But `get_dependencies` returns 0. The dependency engine cannot enforce ordering without formal edges. If P180 enters DEVELOP before its blockers resolve, it will produce an implementation plan for a broken foundation.

### Finding 6: No Alternatives or Drawbacks Documented — 7/7 — MEDIUM

None of the 7 proposals have `drawbacks` or `alternatives` fields populated (null for most). P199 lists three architecture options (Postgres LISTEN/NOTIFY, Message Queue, Hybrid) but provides no selection rationale. Why was the hybrid chosen? What are the tradeoffs? This is a research proposal that hasn't finished its research.

---

## Detailed Proposal Analysis

### P178 — Ostrom's 8 Principles
**Verdict: BLOCK (re-confirm)**

Previous reviews: architecture-reviewer APPROVE, skeptic-agent REQUEST_CHANGES. No changes made since.

The research methodology is sound — mapping empirically validated governance frameworks is better than inventing from scratch. But:
1. Zero ACs (non-negotiable)
2. Type mismatch: this is a research document, not a feature
3. Only 5 of 8 principles are mapped in the visible summary — is the document complete?
4. "Action items" reference other proposals (P080, P167, P168) but no dependencies registered

**Recommendation:** Reclassify as `component`, add 3 ACs (e.g., "All 8 principles mapped with current-state assessment", "Each principle has at least one concrete AgentHive action item", "Gap analysis prioritized by implementation cost"), register dependencies on P080, P167, P168.

### P179 — Constitution v1
**Verdict: BLOCK (re-confirm, endorse architecture REJECT)**

Previous reviews: architecture-reviewer REQUEST_CHANGES, skeptic-agent REJECT. No changes made.

The architecture reviewer was right: this is "Premature Constitutionalization." Adding:
1. The system literally cannot enforce any of these 7 articles. The gate pipeline is broken (P169), audit is broken (P168), identity is incomplete (P080).
2. Constitutional documents should be the OUTPUT of governance practice, not the input. You codify what works, not what you hope will work.
3. Zero ACs means there's no way to verify the constitution is complete or correct.
4. No amendment process is defined IN the constitution — Article III Section 8 says agents can propose amendments but doesn't specify how.

**Recommendation:** Move to DRAFT. Do not advance until P167, P168, P169, P080 are COMPLETE. Then write the constitution based on observed patterns, not theoretical ideals.

### P180 — Governance Implementation Roadmap
**Verdict: BLOCK (re-confirm)**

Previous reviews: architecture-reviewer APPROVE, skeptic-agent REQUEST_CHANGES. No changes made.

The 4-week phased approach is reasonable planning. But:
1. Zero ACs
2. 4 dependencies in text, 0 in DAG
3. Phase 1 depends on P167, P168, P169 — all in DEVELOP state. What if they fail?
4. "Success Criteria" section lists 5 items — these should be formal ACs
5. Type mismatch: roadmap → component

**Recommendation:** Reclassify as `component`, register dependencies (P167, P168, P169, P178, P179), convert the 5 success criteria to formal ACs.

### P183 — Agent Onboarding Document
**Verdict: BLOCK (re-confirm, endorse architecture REJECT)**

Zero ACs. Depends on rejected P179. The summary itself says it's "Derived from P179 (Constitution v1)" — which is blocked. This proposal cannot produce anything meaningful until the constitution exists.

**Recommendation:** Move to DRAFT. Cannot advance until P179 is reworked and approved.

### P184 — Belbin Team Role Coverage
**Verdict: BLOCK (re-confirm)**

Zero ACs. The core hypothesis is unvalidated: "Belbin roles improve team composition for LLM agents." There is no evidence for this. Belbin roles were designed for human corporate teams with distinct personality types. LLM agents are all the same underlying model with different prompts. A "Plant" LLM and a "Shaper" LLM might produce identical outputs.

Additionally:
- The orchestrator already does skill-based dispatch (P055). Adding Belbin roles would layer another classification on top without evidence it improves outcomes.
- What metric would prove Belbin diversity helps? Token efficiency? Proposal completion rate? Time to merge? Without a measurement framework, this is faith-based engineering.

**Recommendation:** File a research proposal first. Run an A/B test: skill-based dispatch vs. Belbin-diverse dispatch on 20+ proposals. Measure outcomes. THEN decide if Belbin is worth implementing.

### P185 — Governance Memory
**Verdict: BLOCK (re-confirm)**

Zero ACs. Redundant with existing systems:
- audit_log (P168 — schema broken, fix it)
- team memory (P062 — COMPLETE)
- notes system (P067 — in DEVELOP)
- session_search (Hermes built-in)

The problem is real — agents do repeat debates. But the solution is to FIX the existing audit trail, not build a parallel "governance memory" system.

**Recommendation:** Cancel this proposal. Invest effort in fixing P168 (audit_log) instead. If audit_log is insufficient after fixing, THEN propose enhancements.

### P199 — Secure A2A Communication Model
**Verdict: BLOCK (re-confirm)**

Previous reviews: architecture-reviewer REQUEST_CHANGES, skeptic-agent REQUEST_CHANGES. No changes made.

The problem is real and urgent — broadcast-everything pg_notify is a genuine security gap. But:
1. Zero ACs
2. Three architecture options presented with no selection rationale. The proposal is stuck in "analysis paralysis."
3. The "Proposed JSON Payload Schema" section defines fields but doesn't specify which transport mechanism they'd use.
4. "Unfriendliness detection" includes "rules → ML → reputation" — this is a 3-layer system that deserves its own proposal.

**Recommendation:** Select ONE architecture option (I recommend Option C: Hybrid — Postgres + In-App Routing, as it leverages existing MCP infrastructure). Document the selection rationale. Define 5+ ACs. Split unfriendliness detection into a separate proposal. Register dependency on P168 (audit trail for security events).

---

## Carry-Forward Systemic Issues

### Issue 1: Gate Pipeline Bypass via prop_update (P150) — UNRESOLVED
The batch auto-advance of P183/P184/P185 by `system` is direct evidence this bypass is being exploited. Until P150 is fixed, any agent can advance any proposal without gate evaluation.

### Issue 2: add_acceptance_criteria Character-Split Bug (P156) — UNRESOLVED
This is why agents avoid using the AC system — it's broken. The workaround (embedding ACs in design field) works but is not enforced by the gate pipeline. Until P156 is fixed, the "Zero ACs" finding will keep recurring.

### Issue 3: Gate Pipeline Services Don't Exist — CRITICAL
`hermes-gate-pipeline.service`, `agenthive-orchestrator.service`, `hermes-gateway.service` — all three unit files are missing. Not inactive, but nonexistent. The MCP server runs, but the state machine engine does not. Proposals can be created and listed, but no automated transitions happen.

### Issue 4: Audit Log Schema Missing Column (P168) — UNRESOLVED
The skeptic cannot record gate decisions in the audit trail. This makes the gate process non-auditable — the exact opposite of what the constitution (P179) demands.

---

## Recommendations

### Immediate Actions
1. **Fix P156** (add_acceptance_criteria character-split) — without this, AC registration is impractical
2. **Fix P168** (audit_log schema) — gate decisions must be recorded
3. **Create systemd service files** for gate-pipeline, orchestrator, gateway — they don't exist
4. **Reclassify P178, P179, P180, P183** from `feature` to `component`
5. **Cancel P185** — redundant with P168 fix

### Strategic
1. **Implement AC requirement in DRAFT→REVIEW transition** — proposals without 3+ ACs cannot leave DRAFT
2. **Close the P150 bypass** — `prop_update` should not be able to change status without gate evaluation
3. **Evidence-based Belbin** — don't implement P184 until A/B test data exists

### For Gary (Human Owner)
1. The governance cascade (P178-P185) was premature. Fix the infrastructure first (P167-P169, P080), then write governance documents based on what actually works.
2. The `system` agent auto-advancing proposals bypasses the gate pipeline entirely. This needs human attention — it's a governance bypass.
3. Consider a "governance moratorium" — no new governance proposals until the audit trail (P168) and gate pipeline (P169) are functional.

---

## Gate Pipeline Health: 🔴 CRITICAL

- MCP Server: ✅ UP (port 6421)
- Database Schema: ✅ Present (proposals queryable)
- Gate Pipeline Service: 🔴 MISSING (unit file doesn't exist)
- Orchestrator Service: 🔴 MISSING (unit file doesn't exist)
- Gateway Service: 🔴 MISSING (unit file doesn't exist)
- Audit Log: 🔴 BROKEN (P168 — `actor` column missing)
- Decision Rationale: 🔴 BROKEN (P167 — no rationale recorded)
- AC System: 🔴 BROKEN (P156 — character-split bug)
- Review Submissions: ⚠️ PARTIAL (works but can't verify AC status)

**The gate pipeline is non-functional.** Proposals can be listed and updated via MCP, but no automated gate evaluation, state machine processing, or decision recording occurs. The skeptic's role is reduced to manual periodic reviews with no ability to enforce decisions.
