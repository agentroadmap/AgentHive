# P222 Gate Decision — Skeptic Beta
## SMDL — Consolidate Gate Evaluators
### DEVELOP → Merge | Decision: SEND BACK

**Date:** 2026-04-21
**Agent:** worker-8617 (skeptic-beta)
**From:** DEVELOP | **To:** Merge (rejected)

---

## Summary

**Zero implementation exists.** All 33 ACs remain pending. The proposal contains only a design document with TypeScript pseudocode — no files, no DB migrations, no tests, no integration.

---

## Audit Findings

### Files Specified in Design — None Exist

| Expected File | Status |
|---|---|
| `src/core/gate/evaluator-modes.ts` | MISSING |
| `src/core/gate/evaluators/auto-evaluator.ts` | MISSING |
| `src/core/gate/evaluators/ai-agent-evaluator.ts` | MISSING |
| `src/core/gate/evaluators/quorum-evaluator.ts` | MISSING |
| `src/shared/smdl/workflow-tools.ts` | MISSING |

### Database Schema — Columns Missing

- `roadmap.gate_task_templates` lacks `evaluator_mode` (auto|ai-agent|quorum) and `evaluator_config` (jsonb) columns
- Current columns: id, gate_number, from_state, to_state, task_prompt, description, is_active, created_at, updated_at
- `fn_enqueue_mature_proposals` function does not exist
- No `CHECK (from_state = UPPER(from_state))` constraint on `proposal_valid_transitions`

### Tests — None Exist

- No `auto-transition.test.ts`
- No evaluator unit tests
- No E2E test for auto-gate flow

### Existing Duplication — NOT Consolidated

Two separate implementations of SMDL workflow loading exist and are NOT consolidated:
1. `src/core/workflow/smdl-loader.ts` — 948 lines, embedded builtins, full materialization
2. `src/apps/mcp-server/tools/workflow/smdl-mcp.ts` — 665 lines, independent re-implementation with duplicated types, duplicated builtin SMDLs, and its own materialization logic

These share no imports. Each has its own type definitions (SMDLStage, SMDLTransition, SMDLRole, SMDLWorkflow, SMDLRoot), own validation, own DB insertion logic. This is the exact duplication the proposal aims to fix, and it remains unfixed.

---

## AC Verification (all 33 ACs: FAIL)

| AC | Requirement | Status |
|---|---|---|
| 1/12/24 | GateEvaluator interface with evaluate(proposal, gate): Promise<GateDecision> | NOT IMPLEMENTED |
| 2/13/25 | AutoEvaluator — AC pass rate check, no cubic dispatch | NOT IMPLEMENTED |
| 3/14/26 | AIAgentEvaluator — cubic dispatch with gate task | NOT IMPLEMENTED |
| 4/15/27 | QuorumEvaluator — count approvals, check quorum_size | NOT IMPLEMENTED |
| 5/16/31 | gate_task_template has evaluator_mode + evaluator_config columns | NOT IMPLEMENTED |
| 6/17/28 | SMDL tools consolidated in src/shared/smdl/workflow-tools.ts | NOT IMPLEMENTED |
| 7/29 | Both MCP namespaces import shared (no duplication) | NOT IMPLEMENTED |
| 8/18/30 | Uppercase state names enforced (DRAFT, REVIEW, etc.) | NOT IMPLEMENTED |
| 9/20/32 | fn_enqueue_mature_proposals checks evaluator_mode, auto-advances | NOT IMPLEMENTED |
| 10/21/33 | Auto-gates produce zero cubic dispatch | NOT IMPLEMENTED |
| 11/22/23 | E2E test: auto-gate transitions without agent dispatch | NOT IMPLEMENTED |

---

## Required Work

1. **Create `src/core/gate/evaluator-modes.ts`** — GateEvaluatorMode type, GateEvaluatorConfig interface, GateEvaluator interface, GateEvaluatorFactory
2. **Create evaluator implementations** — AutoEvaluator, AIAgentEvaluator, QuorumEvaluator with full error handling
3. **Create `src/shared/smdl/workflow-tools.ts`** — consolidate validateSMDL, materializeSMDL, getSMDLMetadata
4. **Refactor both MCP tools** to import from shared library instead of duplicating
5. **DB migration** — add evaluator_mode (enum/TEXT CHECK) and evaluator_config (JSONB) to gate_task_templates
6. **DB migration** — add uppercase CHECK constraint on proposal_valid_transitions from_state/to_state
7. **DB function** — create fn_enqueue_mature_proposals with evaluator_mode branching
8. **Unit tests** — each evaluator mode tested independently with mocked DB
9. **E2E test** — auto-gate with 95%+ AC pass rate auto-advances without cubic creation

---

## Decision

**SEND BACK to DEVELOP** with maturity reset to new.

This proposal has a solid design but zero code. The implementation is a multi-file, multi-migration effort that hasn't started. No amount of review can advance an empty worktree.
