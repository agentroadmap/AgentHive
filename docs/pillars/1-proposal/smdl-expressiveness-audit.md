# SMDL Expressiveness Audit — P374 AC-1

**Author:** P374 architect pass  
**Date:** 2026-05-26  
**SMDL version audited:** v1 (P825 DB-only, `smdl-loader.ts`)

---

## Audit Scope

Three real AgentHive workflows tested against SMDL v1:

| Workflow | Stages | Roles | Transitions |
|---|---|---|---|
| RFC 5-Stage | 5 | 4 | 11 |
| Incident Response | 7 | 5 | 12 |
| Code Review | 5 | 3 | 6 |

Evaluation axes: state complexity, transition logic, role/permission model, gate
evaluation, data flow.

Severity scale: **P0** = cannot express at all | **P1** = requires brittle workaround |
**P2** = expressible but verbose | **OK** = natively supported.

---

## Workflow 1: RFC 5-Stage

### What SMDL CAN express natively

| Feature | SMDL construct |
|---|---|
| Five linear stages with ordered advancement | `stages[].order` |
| Role-restricted forward transitions (PM, Architect) | `transitions[].allowed_roles` |
| Backward iteration transitions (REVIEW→DRAFT) | separate `transitions` entries with `labels:['iterate']` |
| Self-loop transitions for division and dependency-wait | `from == to` transitions |
| AC requirement before advancing | `transitions[].requires_ac` |
| Quorum on REVIEW (2 of PM+Architect, veto) | `stages[].quorum` |
| Auto-advance on maturity | `stages[].auto_transitions.on_mature` |

### Gaps & Severity

| Gap | Severity | Notes |
|---|---|---|
| **No distinction between "iteration" and "division" self-loops** — both encoded as `from==to` transitions with different labels, but the engine treats them identically | P2 | SMDL has no semantic tag for loop intent; gate cron cannot distinguish pause-for-deps from split-for-child |
| **No weighted gate evaluation** — REVIEW gate is pass/fail even when quorum has partial scores | P1 | Must be added as an evaluator mode (see AC-5) |
| **No conditional branching on proposal attributes** — e.g., if `cost_usd > 5000` require Skeptic clearance | P1 | Guards in SMDL only express role/AC; no predicate language for attribute-based branching |
| **No history state** — when a proposal iterates DEVELOP→REVIEW, the prior REVIEW decisions are not preserved in SMDL; must be tracked in separate audit table | P2 | Workaround: proposal_state_transitions audit table already exists |
| **Nested sub-workflow per stage** — e.g., DEVELOP has its own internal sub-states (design→code→test) that SMDL cannot model | P0 | SMDL v1 has no nested/hierarchical state support |
| **No parallel stages** — cannot model REVIEW happening concurrently with a legal check | P0 | Single-active-stage model only |
| **Context passing between stages** — design artifacts from DRAFT are not typed hand-offs to REVIEW in SMDL | P2 | SMDL has no `inputs`/`outputs` per stage; data flow implicit through proposal fields |

---

## Workflow 2: Incident Response

Reference definition (AgentHive ops practice):

```
DETECTED → TRIAGED → INVESTIGATING → MITIGATING → RESOLVED → POSTMORTEM → CLOSED
           ↓ (timeout 15m)                ↓ (escalate)
         ESCALATED ←─────────────────────────────
```

Stages: DETECTED, TRIAGED, ESCALATED, INVESTIGATING, MITIGATING, RESOLVED, POSTMORTEM, CLOSED  
Roles: on-call, incident-commander, tech-lead, comms, reviewer

### What SMDL CAN express natively

| Feature | SMDL construct |
|---|---|
| Linear incident stages | `stages[].order` |
| Auto-triage timeout (15 min) | `stages[].timeout: '15m'` + `auto_transitions.on_timeout` |
| Escalation as a stage | separate `ESCALATED` stage with high order |
| Role restrictions (only incident-commander can close) | `transitions[].allowed_roles` |
| Auto-advance to POSTMORTEM on RESOLVED | `auto_transitions.on_mature` |
| Quorum on RESOLVED (tech-lead + comms must concur) | `stages[].quorum` |

### Gaps & Severity

| Gap | Severity | Notes |
|---|---|---|
| **Conditional escalation path** — ESCALATED is triggered either by timeout OR by on-call manually; SMDL cannot express `on_timeout OR on_request`; requires two separate transitions | P2 | Workaround: add both a timeout transition and an explicit role-triggered transition |
| **Parallel notification side-effects** — when ESCALATED, SMDL cannot model "simultaneously notify comms channel AND page incident-commander" | P0 | SMDL has no side-effect actions on transitions |
| **SLA-linked maturity gate** — "P1 incident must clear MITIGATING in < 30 min"; SMDL timeout is a coarse deadline, not a SLA-graded gate | P1 | No severity/SLA field on stages |
| **Multi-responder coordination** — INVESTIGATING may have 3 agents working simultaneously; SMDL has no `agent_count` or `squad` annotation per stage | P0 | Requires AC-6 multi-agent extension |
| **Stateful escalation reason** — SMDL transitions have `labels` but no typed payload; cannot carry "escalation reason code" through the state machine | P1 | Must be stored externally; SMDL has no `context` field on transitions |
| **Dynamic role assignment** — incident-commander is assigned at runtime (whoever is on-call); SMDL roles are static definitions | P1 | No runtime role binding in SMDL; workaround: `allowed_roles: ['any']` loses access control |

---

## Workflow 3: Code Review

Reference: PR opened → review assigned → review active → approved → merged/closed

### What SMDL CAN express natively

| Feature | SMDL construct |
|---|---|
| Four-stage review pipeline | `stages[].order` |
| Reviewer quorum (2 approvals, veto power) | `stages[].quorum` |
| Timeout on APPROVED stage (48h merge window) | `stages[].timeout` |
| Reviewer/Maintainer role split | `transitions[].allowed_roles` |
| Author can request review re-open | `transitions` with `allowed_roles: ['Author']` |
| Both MERGED and CLOSED terminal stages | `terminal_stages: ['MERGED','CLOSED']` |

### Gaps & Severity

| Gap | Severity | Notes |
|---|---|---|
| **Review comment threading** — specific line comments and resolution state are external to SMDL | P2 | By design; SMDL is workflow control, not content. No gap for core purpose. |
| **CI gate dependency** — "advance to APPROVED only if CI is green" requires external signal not modeled in SMDL | P1 | No `external_gate` or `signal_required` primitive; must poll externally and manually trigger transition |
| **Reviewer assignment** — who reviews is not modeled (SMDL says "Reviewer role" but not which agent fills it) | P1 | Dynamic assignment outside SMDL scope; no `assign_role_to` action |
| **Draft PR state** — code-review has a draft/WIP sub-state within OPEN that SMDL cannot represent without a separate stage | P2 | Workaround: add `DRAFT_PR` as a stage; semantically ugly |
| **Stale review invalidation** — if Author pushes new commits after review, existing approvals should be invalidated; SMDL has no `invalidate_quorum_on_event` | P1 | No event-driven quorum invalidation primitive |

---

## Consolidated Gap Matrix

| Gap | RFC-5 | Incident | Code Review | Severity | Priority |
|---|---|---|---|---|---|
| Nested / hierarchical states | P0 | — | P2 | **P0** | v3 |
| Parallel stages / fork-join | P0 | P0 | — | **P0** | v3 |
| Transition side-effect actions | — | P0 | — | **P0** | v2 |
| Multi-agent dispatch per stage | — | P0 | — | **P0** | AC-6 |
| Weighted gate scoring | P1 | P1 | P1 | **P1** | AC-5 |
| Attribute-predicate guards | P1 | — | P1 | **P1** | v2 |
| Context / typed data hand-offs | P2 | P1 | — | **P1** | v2 |
| Dynamic role assignment | — | P1 | P1 | **P1** | v2 |
| External signal gates (CI, webhook) | — | — | P1 | **P1** | v2 |
| Quorum invalidation on event | — | — | P1 | **P1** | v2 |
| SLA-graded timeout | — | P1 | — | **P1** | v2 |
| History states | P2 | — | — | **P2** | v3 |
| Self-loop semantic distinction | P2 | — | — | **P2** | v2 |
| Stateful transition payload | — | P1 | — | **P1** | v2 |

### Severity Summary

| Severity | Count | Meaning |
|---|---|---|
| P0 — Cannot express | 4 gaps | Needs new SMDL constructs |
| P1 — Brittle workaround | 8 gaps | Expressible with degraded semantics |
| P2 — Verbose but OK | 4 gaps | Minor ergonomic issues |

### Immediate Action Items

1. **AC-6 (this proposal)** — multi-agent dispatch solves the Incident Response P0 gap for parallel responders.
2. **AC-5 (this proposal)** — weighted scoring closes the P1 gate evaluation gap across all three workflows.
3. **v2 target** — transition side-effect actions and attribute-predicate guards are the highest-value P0/P1 gaps not covered by this proposal.
4. **v3 target** — nested states and parallel stages; XState/BPMN patterns recommended (see AC-3 comparative analysis).

---

## Conclusion

SMDL v1 is **adequate for simple linear workflows** (Quick-Fix, standard RFC) but has
**meaningful gaps for operational workflows** (Incident Response). The four P0 gaps
(nested states, parallel stages, side-effect actions, multi-agent dispatch) are
architectural — they require new SMDL constructs rather than configuration-level
workarounds. The P374 expansion proposals (AC-5 weighted scoring, AC-6 multi-agent)
close 2 of 4 P0 gaps and the majority of P1 gaps.

SMDL remains **well-positioned for its core purpose** (agent-native proposal/task workflow
management) and does not need to become a full BPMN replacement. Selective expansion is
the right strategy.
