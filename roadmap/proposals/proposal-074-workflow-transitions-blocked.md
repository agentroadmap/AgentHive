# P074: workflow_load_builtin populates workflow_stages but prop_transition reads proposal_valid_transitions — all transitions blocked

**Status:** COMPLETE | **Type:** Issue | **Priority:** Critical | **Workflow:** RFC 5-Stage

---

## Problem

The SMDL loader (`workflow_load_builtin`) materialized workflow definitions into `workflow_stages` and `workflow_transitions` tables. However, `prop_transition` validation queried `proposal_valid_transitions` — a separate table that was never populated by the SMDL loader.

**Result:** `proposal_valid_transitions` had 0 rows for all three builtin workflows (Standard RFC, Quick Fix, Code Review Pipeline). Every `prop_transition` call returned "Transition X → Y not allowed". No proposal could advance past Draft.

### Verification Query (pre-fix)

```sql
SELECT wt.name, COUNT(pvt.id) AS transitions
FROM roadmap.workflow_templates wt
LEFT JOIN roadmap.proposal_valid_transitions pvt
  ON pvt.workflow_name = wt.name
GROUP BY wt.name;
-- Returned 0 transitions for all workflows
```

## Root Cause

Two separate code paths evolved independently:

1. **SMDL loader path:** `smdl-loader.ts` → populates `workflow_stages` + `workflow_transitions` (SMDL-native tables)
2. **Validation path:** `prop_transition` handler → queries `proposal_valid_transitions` (legacy table from earlier migrations)

Neither path synced to the other.

## Fix Applied

**Chosen: Option A** — Keep `proposal_valid_transitions` as the canonical validation table; ensure all workflow loading and migration paths populate it.

### Implementation Pattern

The fix ensures every workflow modification updates BOTH tables:

1. **`workflow_transitions`** — SMDL-native, used for workflow visualization and introspection
2. **`proposal_valid_transitions`** — used by `prop_transition` handler for state machine validation

Migration 044 (`044-enriched-workflow-stages.sql`) demonstrates the pattern:
- Modify `workflow_stages` + `workflow_transitions` for the new stages
- Mirror the same transitions into `proposal_valid_transitions` with matching `workflow_name`, `from_state`, `to_state`, `allowed_reasons`, `allowed_roles`, `requires_ac`

### Rejected Alternatives

- **Option B** (rewrite `prop_transition` to read `workflow_transitions`): Larger change, risk of breaking existing handlers.
- **Option C** (SQL-only backfill migration): Stopgap — wouldn't stay in sync on future workflow loads.

## Current State

`proposal_valid_transitions` is now populated for all workflows:

| Workflow | Transitions |
|---|---|
| Standard RFC | 12 (includes CODEREVIEW/TESTWRITING/TESTEXECUTION stages) |
| Quick Fix | 6 (includes TESTEXECUTION stage) |
| Code Review Pipeline | 6 |
| Hotfix | 7 |

## Lessons Learned

1. **Schema evolution creates split-brain.** When two tables serve overlapping purposes, a loader that populates one but not the other creates silent failures.
2. **Data-driven validation needs sync contracts.** If `prop_transition` depends on `proposal_valid_transitions`, any loader that creates workflow rules must write to that table.
3. **Systematic audits catch these.** The bug was found by querying row counts per workflow — a simple `COUNT(*)` sanity check would have caught it on first load.

## Related

- Migration 004: `004-workflow-multi-template-support.sql` — multi-template support, created `v_known_states` view
- Migration 044: `044-enriched-workflow-stages.sql` — enriched stages, demonstrated dual-table sync pattern
- P227: Enriched Workflow Stages (CODEREVIEW/TESTWRITING/TESTEXECUTION)
- Configurable Workflow Engine design: `roadmap/docs/configurable_workflow_engine.md`
