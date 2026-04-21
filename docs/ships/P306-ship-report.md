# P306 Ship Report: Normalize Proposal Status Casing

**Proposal:** P306
**Title:** Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs
**Status:** COMPLETE (obsolete)
**Shipped:** 2026-04-21

---

## What Was Fixed

Live database had 10 distinct status values with mixed casing (DRAFT, Draft, REVIEW, Review, DEVELOP, Develop, MERGE, Merge, COMPLETE, Complete, DEPLOYED). Proposals with title-case status bypassed filters expecting uppercase, causing gate loops, missed dispatches, and board display inconsistencies.

## What Was Delivered

### Phase 1 — DB Migration
- Normalized all 44 mixed-case proposals to UPPERCASE
- Created trigger `fn_normalize_proposal_status()` — auto-upcases status on INSERT/UPDATE
- CHECK constraint `proposal_status_canonical` validates all 28 reference_terms values
- Trigger fires BEFORE CHECK, so only uppercase reaches the column

### Phase 2 — Code Cleanup
- Removed LOWER() workarounds from:
  - `scripts/orchestrator.ts` line 888
  - `scripts/bootstrap-state-machine.ts` lines 45, 105
- Preserved intentional LOWER() in:
  - `src/core/pipeline/pipeline-cron.ts:1278` (cross-table comparison with transition_queue.to_stage)
  - Historical data queries (proposal_state_transitions, dag-health.ts)

### Phase 3 — Input Guard
- `createProposal()` normalizes status to uppercase before INSERT
- Belt-and-suspenders with the trigger

## Acceptance Criteria Results

| # | Criteria | Status |
|---|----------|--------|
| 1 | All status values UPPERCASE | PASS — 6 uppercase statuses |
| 2 | Zero residual mixed-case | PASS — 0 rows |
| 3 | Exactly 6 distinct statuses | PASS — DRAFT(35), REVIEW(9), DEVELOP(32), MERGE(1), COMPLETE(73), DEPLOYED(34) |
| 4 | Trigger functional | PASS — fn_normalize_proposal_status EXISTS, UPPER(NEW.status) |
| 5 | CHECK constraint functional | PASS — proposal_status_canonical EXISTS |
| 6 | Code cleanup verified | PASS — no LOWER(status) in orchestrator.ts or bootstrap-state-machine.ts |
| 7 | LOWER() preserved where required | PASS — pipeline-cron.ts:1278 still has LOWER() |
| 8 | No regressions | PASS — orchestrator active, running healthy |

## Design Decisions

1. **terminology.ts stays title-case** — display layer, trigger catches at DB boundary
2. **transition_queue.to_stage stays title-case** — 98.7% title-case data, out of scope
3. **CHECK lists both cases** — trigger normalizes before CHECK evaluates; both forms provide clear error messages if trigger is bypassed

## Risk Assessment

- CHECK constraint allows both cases: mitigated by trigger firing before CHECK
- proposal_state_transitions not normalized: 261 mixed-case rows remain, handled by LOWER() in queries
- terminology.ts root cause not changed: trigger catches at DB boundary, correct layered approach

## Files

- Design doc: `docs/plans/P306-normalize-status-casing.md`
- Migration: `database/ddl/v4/044-normalize-proposal-status-casing.sql`

## Impact

- Discord bridge: case-sensitive NOT IN now works correctly (13 Complete proposals no longer leak through)
- Board UI: no more duplicate columns from mixed-case grouping
- Orchestrator gate poll: no more LOWER() overhead on 30s cycle
- Pipeline cron: intentional LOWER() preserved for cross-table comparisons
- Proposal storage: case-sensitive filters now match all proposals
