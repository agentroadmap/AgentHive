# P382: Gate dispatches complete but proposals stuck — wrong role dispatched

## Problem Statement

P046 was stuck in DEVELOP for 6+ hours with 10+ completed gate dispatches (all `skeptic-beta`, D3 gate) but never advanced to MERGE.

## Root Cause

The orchestrator's `dispatchImplicitGate` function dispatches gates using a hardcoded role from `GATE_ROLES`:

```
DEVELOP state → D3 gate → dispatch_role = "skeptic-beta"
```

But the workflow transition DEVELOP→MERGE (`proposal_valid_transitions`) requires:

```
allowed_roles = {PM, Architect}
```

`skeptic-beta` is NOT in `{PM, Architect}`. So:

1. Gate dispatch completes (skeptic-beta approves)
2. Gate agent calls `prop_transition` to MERGE
3. State machine rejects — wrong role
4. Maturity remains `mature` → orchestrator re-dispatches
5. Infinite loop

## Evidence

### workflow_transitions (Standard RFC)
```
DEVELOP → MERGE    : allowed_roles = {PM, Architect}
DEVELOP → REJECTED : allowed_roles = {PM, Architect}
DEVELOP → REVIEW   : allowed_roles = {Architect}
```

### GATE_ROLES (orchestrator.ts)
```
D1 → skeptic-alpha    (DRAFT→Review)
D2 → architecture-reviewer  (REVIEW→Develop)
D3 → skeptic-beta     (DEVELOP→Merge)    ← MISMATCH
D4 → gate-reviewer    (MERGE→Complete)
```

### P046 dispatches (10+ with same pattern)
- squad_name: `gate-P046-D3`
- dispatch_role: `skeptic-beta`
- dispatch_status: completed (repeatedly)
- Proposal stays: DEVELOP, maturity=mature

## Design

### 1. Pre-dispatch role validation in `dispatchImplicitGate`

Before dispatching, query `workflow_transitions` for the allowed_roles on the inferred transition:

```typescript
const { rows: transitions } = await query<{ allowed_roles: string[] }>(
  `SELECT allowed_roles FROM roadmap.workflow_transitions
   WHERE from_stage = $1 AND to_stage = $2
   LIMIT 1`,
  [normalizeState(proposal.status), gate.toStage],
);

if (transitions.length > 0) {
  const allowed = transitions[0].allowed_roles;
  if (!allowed.includes(role)) {
    // Gate default role is not allowed for this transition
    // Find a compatible role from the allowed set
    const fallback = mapAllowedRoleToDispatch(allowed);
    if (!fallback) {
      logger.warn(`No dispatch role available for ${proposal.display_id}: allowed_roles=${allowed}, default=${role}`);
      return; // Skip dispatch — don't create dead dispatches
    }
    logger.log(`Role override for ${proposal.display_id}: ${role} -> ${fallback} (allowed: ${allowed})`);
    role = fallback;
  }
}
```

### 2. Role mapping function

Map workflow transition roles to dispatch roles:

```typescript
const WORKFLOW_TO_DISPATCH: Record<string, string> = {
  'PM': 'pm',
  'Architect': 'architect',
  'Maintainer': 'gate-reviewer',
  'Reviewer': 'reviewer',
};

function mapAllowedRoleToDispatch(allowed: string[]): string | null {
  for (const wfRole of allowed) {
    const dispatchRole = WORKFLOW_TO_DISPATCH[wfRole];
    if (dispatchRole) return dispatchRole;
  }
  return null;
}
```

### 3. Gate pipeline defense-in-depth

In the gate-pipeline transition handler, validate that the dispatch role is in `allowed_roles` before calling `prop_transition`. If validation fails, log the mismatch and set maturity to `new` with a discussion entry explaining the failure.

### 4. Fixed GATE_ROLES (updated defaults)

Ensure D2 and D3 gate roles are compatible with workflow transitions:

```
D2: architecture-reviewer  (has "design" capability → maps to Architect concept)
D3: architect (change from skeptic-beta — but this requires architect agents)
```

**Alternative:** Keep GATE_ROLES as-is, and let the pre-dispatch validation handle role override. This is safer because it doesn't break transitions where skeptic-beta IS allowed.

## Files to Modify

1. `scripts/orchestrator.ts` — `dispatchImplicitGate` (add role validation)
2. `scripts/gate-pipeline.ts` — transition handler (defense-in-depth)
3. Gate role mapping function (new)

## Acceptance Criteria

1. Gate dispatch role matches workflow_transitions.allowed_roles
2. Gate completion validates role before state transition
3. P046 advances DEVELOP to MERGE after proper gate evaluation
4. Role validation is logged for debugging
