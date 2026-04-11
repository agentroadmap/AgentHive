# Fix: Workflow Mismatch for P079 and P080

## Problem

Issues P079 and P080 (type `issue`) were stuck in `Draft` state but bound to the **Quick Fix** workflow, which has no `Draft` stage. The Quick Fix workflow stages are: TRIAGE, FIX, DEPLOYED, ESCALATE, WONT_FIX.

### Symptom

`prop_update` / `prop_transition` failed with:
```
Transition Draft -> TRIAGE not allowed for this proposal's workflow
```

### Root Cause

Two issues combined:

1. **Trigger vs explicit status mismatch**: The `fn_spawn_workflow` trigger correctly created the workflow instance with `current_stage='TRIAGE'`, but the proposals' `status` column remained `'Draft'`. This happened because `createProposal()` accepted `input.status` as-is without validating it against the workflow's stages. If `status='Draft'` was explicitly passed (or defaulted), it overrode the workflow's correct start stage.

2. **No transition from Draft in Quick Fix**: The `transitionProposal()` validation queries `proposal_valid_transitions` for `from_state='Draft'` in the Quick Fix workflow. Since Quick Fix has no Draft stage, no transitions are defined from Draft, so the validation fails.

### Data Evidence

Before fix:
```
P079: type=issue, status='Draft', workflow='Quick Fix', workflow.current_stage='TRIAGE'
P080: type=issue, status='Draft', workflow='Quick Fix', workflow.current_stage='TRIAGE'
```

The `workflows.current_stage` was correct (TRIAGE), but `proposal.status` was wrong (Draft).

## Fix Applied

### 1. Data Migration (scripts/fix-p079-p080-workflow.ts)

Directly updated `proposal.status` from `'Draft'` to `'TRIAGE'` for both proposals:

```sql
UPDATE roadmap.proposal
SET status = 'TRIAGE', modified_at = NOW()
WHERE display_id IN ('P079', 'P080') AND status = 'Draft';
```

The `trg_proposal_state_change` trigger automatically logged the state change in `proposal_state_transitions` and the audit JSONB.

### 2. Code Fix (src/infra/postgres/proposal-storage-v2.ts)

Modified `createProposal()` to validate `input.status` against the workflow's valid stages. If the provided status doesn't exist in the workflow's stages, it silently falls back to the workflow's start stage.

**Before:**
```typescript
let initialStatus = input.status ?? "Draft";
if (!input.status) {
  // lookup workflow start stage...
}
```

**After:**
```typescript
// Always fetch workflow's valid stages and start stage
const { rows: wfRows } = await query<{ start_stage, valid_stages }>(...);

if (input.status && validStages.length > 0) {
  // Validate: does the provided status exist in the workflow?
  const matchStage = validStages.find(s => s.toLowerCase() === input.status!.toLowerCase());
  initialStatus = matchStage ?? startStage ?? "Draft";
} else {
  // fallback to workflow start stage or "Draft"
}
```

## After Fix

```
P079: type=issue, status='TRIAGE', workflow='Quick Fix', maturity={TRIAGE: 'new'}
P080: type=issue, status='TRIAGE', workflow='Quick Fix', maturity={TRIAGE: 'new'}
```

Valid transitions from TRIAGE (Quick Fix):
- TRIAGE -> FIX (any role, reason: mature/accepted)
- TRIAGE -> WONT_FIX (Lead role, reason: reject/discard)

## How to Prevent

The code fix in `createProposal()` prevents future occurrences by silently correcting invalid status values. However, agents should:

1. Always use `type` field when creating proposals (not `status`) to let the workflow determine the initial state
2. Use `prop_transition` (not `prop_update`) to change proposal status, as it validates against the workflow
3. If a proposal gets into an invalid state, use the fix script or direct SQL to correct the status to a valid workflow stage

## Files Modified

- `src/infra/postgres/proposal-storage-v2.ts` - Added status validation in `createProposal()`
- `scripts/fix-p079-p080-workflow.ts` - Data migration script (run once)
- `docs/research/workflow-mismatch-fix.md` - This document
