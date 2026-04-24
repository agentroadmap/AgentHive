# P206 Gate Decision — Skeptic Beta
## Gate Evaluator Agent — Automated Mature→Advance Transitions
### DEVELOP → Merge | Decision: HOLD (SEND BACK)

**Date:** 2026-04-21
**Agent:** worker-8681 (skeptic-beta)
**From:** Develop | **To:** Merge (rejected)

---

## Summary

**Zero implementation exists.** All 11 ACs remain pending. The proposal contains a solid design document with TypeScript pseudocode but no files, no DB migrations, no tests, no integration code whatsoever.

---

## Audit Findings

### Files Specified in Design — None Exist

| Expected File | Status |
|---|---|
| `src/apps/cubic-agents/gate-evaluator.ts` | MISSING — `src/apps/cubic-agents/` directory is EMPTY |
| `database/ddl/020-gate-decisions.sql` | MISSING |
| `src/sql/functions/fn_enqueue_mature_proposals.sql` | MISSING |
| `tests/unit/gate-evaluator.test.ts` | MISSING |
| `tests/integration/gate-proposal-flow.test.ts` | MISSING |
| `tests/e2e/full-pipeline.test.ts` | MISSING |

### Orchestrator Integration — Missing

- No `handleProposalMature()` method found in `src/apps/orchestrator/`
- No gate-related references in `pipeline-cron.ts`
- No evaluator code in `src/core/gate/` directory

### Existing Infrastructure (Pre-P206)

The gate system has basic infrastructure that predates this proposal:

| Component | Status |
|---|---|
| `gate_task_templates` (roadmap schema) | EXISTS — D1-D4 rows with task prompts |
| `gate_decision_log` (roadmap_proposal schema) | EXISTS — 43 rows recorded |
| `fn_notify_gate_ready()` trigger | EXISTS — fires on maturity='mature' |
| `fn_guard_gate_advance()` trigger | EXISTS — validates decision before transition |
| `v_implicit_gate_ready` view | EXISTS — filters mature proposals needing gates |
| `squad_dispatch` with gate-reviewer role | EXISTS — 253 dispatches recorded |

### Critical Gaps in Existing Infrastructure

1. **No `evaluator_mode` column** on `gate_task_templates` — the auto/ai-agent/quorum mode system is not implemented
2. **No `evaluator_config` JSONB column** on `gate_task_templates`
3. **Non-standardized gate column values** — 14 distinct values in `gate_decision_log` including `skeptic-alpha`, `skeptic-beta`, `architecture-reviewer`, `develop_to_merge`, `DEVELOP->Merge`, `DEVELOP_to_MERGE` — indicates ad-hoc gate dispatch without the pluggable evaluator system
4. **No `fn_enqueue_mature_proposals()` function** in the expected location (roadmap_proposal schema)
5. **`proposal` table lacks `gate_pass_count` / `gate_fail_count` columns** specified in design

### AC Verification (all 11 ACs: PENDING)

| AC | Requirement | Status |
|---|---|---|
| AC-1 | Orchestrator dispatches gate-evaluator when proposals reach mature | PENDING — no dispatch code exists |
| AC-2 | Gate-evaluator verifies AC and calls transition_proposal | PENDING — no evaluator code exists |
| AC-3 | No proposals stuck at mature >10 min without evaluation | PENDING — no timeout/monitoring exists |
| AC-4 | GateEvaluatorAgent class with evaluate() method | PENDING — file doesn't exist |
| AC-5 | gate_decision_log table with required columns | PARTIAL — table exists but schema differs (uses `decision` not `verdict`, has `ac_verification` JSONB) |
| AC-6 | gate_task_template rows for D1-D4 | PARTIAL — rows exist but lack evaluator_mode column |
| AC-7 | fn_enqueue_mature_proposals returns gate_name | PENDING — function doesn't exist in expected schema |
| AC-8 | Orchestrator calls handleProposalMature() | PENDING — method doesn't exist |
| AC-9 | Gate evaluator checks can_promote() | PENDING — no evaluator code exists |
| AC-10 | On approval, status updated and decision logged | PARTIAL — manual process works via triggers, not automated |
| AC-11 | Unit tests for evaluate() | PENDING — no test files exist |

---

## Related Work

P222 (SMDL + Gate Evaluators Consolidation) was sent back on the same date (2026-04-21) for identical reasons — zero implementation, all 33 ACs pending. Both proposals share the gate evaluator infrastructure gap.

---

## Required Work

1. **Create `src/apps/cubic-agents/gate-evaluator.ts`** — GateEvaluatorAgent class with evaluate(proposal, gate) method
2. **DB migration** — add `evaluator_mode` (TEXT CHECK IN auto/ai-agent/quorum) and `evaluator_config` (JSONB) to `gate_task_templates`
3. **DB migration** — add `gate_pass_count` and `gate_fail_count` to `proposal`
4. **Create `src/core/gate/evaluators/`** — AutoEvaluator, AIAgentEvaluator, QuorumEvaluator implementations
5. **Implement `handleProposalMature()`** in orchestrator with evaluator mode dispatch
6. **Create `fn_enqueue_mature_proposals()`** function in roadmap_proposal schema
7. **Standardize gate column values** — enforce D1/D2/D3/D4 naming in gate_decision_log
8. **Unit tests** — each evaluator mode tested independently
9. **Integration test** — proposal reaches mature → evaluator dispatched → decision recorded → status transitioned
10. **E2E test** — full pipeline through all 4 gates

---

## Decision

**HOLD / SEND BACK to DEVELOP** with maturity reset to new.

This proposal has a coherent, well-thought design but zero code. The implementation requires significant multi-file, multi-migration work that hasn't started. The existing gate infrastructure (triggers, decision log, templates) provides a foundation but lacks the pluggable evaluator engine that is the core deliverable of P206.
