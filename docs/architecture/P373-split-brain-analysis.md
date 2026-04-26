# P373 Research: proposal_valid_transitions vs workflow_transitions Split-Brain

**Date:** 2026-04-21  
**Researcher:** worker-8931  
**Status:** DRAFT phase — research complete

## Executive Summary

The split-brain is confirmed. Two transition tables serve different consumers with divergent data. The `Hotfix` workflow has 0 rows in `workflow_transitions` but 7 rows in `proposal_valid_transitions`. The `Quick Fix` workflow has 5 rows in wt vs 6 in pvt (with state name mismatches after migration 044). Only `Standard RFC` and `Code Review Pipeline` are in sync.

## Architecture

### Two Tables, Two Purposes

| Table | Schema | Consumer | Source |
|-------|--------|----------|--------|
| `roadmap.workflow_transitions` | `template_id, from_stage, to_stage, labels, allowed_roles, requires_ac, gating_rules` | SMDL materializer, display/UI | `smdl-loader.ts` + `smdl-mcp.ts` |
| `roadmap_proposal.proposal_valid_transitions` | `workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac` | **`proposal-integrity.ts` transition validation** | `smdl-loader.ts` mirror or manual SQL |

### Critical finding: transition validation uses pvt, NOT wt

In `proposal-integrity.ts:111-142`, the `validateTransitionRule()` function queries:

```sql
SELECT ... FROM roadmap_proposal.proposal_valid_transitions pvt
JOIN roadmap.workflows w ON w.proposal_id = $1
JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
JOIN roadmap_proposal.proposal_type_config ptc ON ptc.workflow_name = wt.name
WHERE pvt.workflow_name = ptc.workflow_name
  AND LOWER(pvt.from_state) = LOWER($2)
  AND LOWER(pvt.to_state) = LOWER($3)
```

This joins: `proposal -> workflows -> workflow_templates -> proposal_type_config -> proposal_valid_transitions`

**If the template doesn't exist or isn't linked, the join chain breaks.**

### SMDL materialization mirrors both

In `smdl-loader.ts:377-420`, `materializeWorkflow()` writes to BOTH tables in a single loop:
1. `INSERT INTO workflow_transitions` (canonical)
2. `INSERT INTO roadmap_proposal.proposal_valid_transitions` (mirror)

Both are written from the same SMDL YAML definition. If neither code path runs, neither table gets populated.

## Current State (verified 2026-04-21)

### Row counts by workflow

| Workflow | pvt rows | wt rows | Match? |
|----------|----------|---------|--------|
| Standard RFC | 12 | 12 | YES |
| Quick Fix | 6 | 5 | NO |
| Hotfix | 7 | 0 | **NO — SEVERE** |
| Code Review Pipeline | 6 | 6 | YES |

### Hotfix: Template exists, transitions don't

- `workflow_templates`: id=37, name='Hotfix', smdl_id=NULL, is_system=FALSE
- `workflow_transitions`: **0 rows** for template_id=37
- `proposal_valid_transitions`: 7 rows with NULL allowed_roles and NULL allowed_reasons
- The template was created outside `materializeWorkflow()` — no SMDL definition, no code path populated wt

### Hotfix pvt rows (all have NULL metadata)

| from_state | to_state | allowed_roles | allowed_reasons |
|------------|----------|---------------|-----------------|
| TRIAGE | FIXING | NULL | NULL |
| TRIAGE | WONT_FIX | NULL | NULL |
| TRIAGE | NON_ISSUE | NULL | NULL |
| TRIAGE | ESCALATE | NULL | NULL |
| FIXING | DONE | NULL | NULL |
| FIXING | TRIAGE | NULL | NULL |
| FIXING | ESCALATE | NULL | NULL |

These NULLs mean the MCP has no role or reason constraints — any agent can transition anything.

### Quick Fix: State name mismatch after migration 044

Migration 044 added TESTEXECUTION stage to the Quick Fix workflow in `workflow_transitions`. The pvt table still has the old transitions:

| pvt (old) | wt (post-044) |
|-----------|---------------|
| TRIAGE -> FIX | TRIAGE -> FIX | 
| FIX -> DEPLOYED | FIX -> TESTEXECUTION |
| FIX -> ESCALATE | FIX -> ESCALATE |
| FIX -> TRIAGE | FIX -> TRIAGE |
| TRIAGE -> WONT_FIX | TRIAGE -> WONT_FIX |
| TRIAGE -> DEPLOYED (extra!) | TESTEXECUTION -> DEPLOYED |

The pvt has TRIAGE->DEPLOYED (not in wt) and lacks TESTEXECUTION entirely.

### Proposal type config vs actual workflow_name

`proposal_type_config` maps: `hotfix -> Hotfix`

But actual hotfix proposals use 3 different workflow_names:

| display_id | workflow_name | status |
|------------|---------------|--------|
| P293 | Hotfix | DEVELOP |
| P297 | Hotfix | COMPLETE |
| P253 | RFC 5-Stage | DRAFT |
| P288 | RFC 5-Stage | DRAFT |
| P278 | RFC 5-Stage | DRAFT |
| P294 | Standard RFC | DEVELOP |

4 out of 6 hotfix proposals have a workflow_name that won't match the Hotfix pvt entries during validation.

## Root Cause Analysis

1. **Hotfix created outside SMDL pipeline.** The template (id=37) was inserted directly into `workflow_templates` without an smdl_id and without calling `materializeWorkflow()`. The pvt rows were also manually inserted with NULL metadata. The wt table was never populated.

2. **No consistency enforcement.** There is no trigger, constraint, or validation job that checks whether `workflow_transitions` and `proposal_valid_transitions` are in sync for a given workflow.

3. **Migration 044 updated wt but not pvt.** When TESTEXECUTION was added to Quick Fix, only `workflow_transitions` was modified. The mirror table was not updated.

4. **proposal.workflow_name is unvalidated free text.** Proposals can have any workflow_name regardless of their type, breaking the ptc-based lookup chain.

## Transition validation path

```
proposal-integrity.ts::validateTransitionRule()
  -> query: pvt JOIN workflows JOIN workflow_templates JOIN proposal_type_config
  -> filters: pvt.workflow_name = ptc.workflow_name AND LOWER(from) = LOWER(to)
```

If a hotfix proposal has workflow_name="RFC 5-Stage", the ptc lookup finds "Hotfix" but the pvt filter won't match.

## Recommendations

1. **Declare source of truth:** `proposal_valid_transitions` is the runtime validation source. `workflow_transitions` is the SMDL materialization artifact. Either promote one to canonical and deprecate the other, or enforce bidirectional sync.

2. **Hotfix SMDL:** Create a proper SMDL definition for Hotfix and load it through `materializeWorkflow()` so both tables get populated consistently.

3. **Sync Quick Fix:** Update pvt rows to match post-migration-044 transitions in wt (add TESTEXECUTION stage, remove TRIAGE->DEPLOYED).

4. **Consistency check:** Add a query or trigger that detects drift between the two tables.

5. **Proposal workflow_name validation:** Constrain proposal.workflow_name to values from proposal_type_config or workflow_templates.

## Files Referenced

- `/data/code/AgentHive/src/core/proposal/proposal-integrity.ts` — transition validation (uses pvt)
- `/data/code/AgentHive/src/core/workflow/smdl-loader.ts` — SMDL materialization (writes both)
- `/data/code/AgentHive/src/apps/mcp-server/tools/workflow/smdl-mcp.ts` — MCP workflow tools (writes both)
- `/data/code/AgentHive/scripts/migrations/044-enriched-workflow-stages.sql` — modified Quick Fix wt only
