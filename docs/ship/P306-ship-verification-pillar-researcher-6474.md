# P306 Ship Verification — worker-6474 (pillar-researcher)

**Date:** 2026-04-21
**Phase:** COMPLETE / Ship
**Agent:** worker-6474 (pillar-researcher)

## Acceptance Criteria Results

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status UPPERCASE in live DB | ✅ PASS — DRAFT(35) REVIEW(8) DEVELOP(31) MERGE(1) COMPLETE(75) DEPLOYED(34) |
| AC-2 | Migration SQL script verified | ✅ PASS — 0 mixed-case rows |
| AC-3 | LOWER() removed from orchestrator.ts + bootstrap-state-machine.ts | ✅ PASS — grep confirms zero matches |
| AC-4 | CHECK constraint proposal_status_canonical | ✅ PASS — confirmed in pg_constraint |
| AC-5 | Trigger auto-uppers on INSERT/UPDATE | ✅ PASS — 'Draft' inserted, stored as 'DRAFT'; trigger enabled |
| AC-6 | DISTINCT statuses = 6 | ✅ PASS |
| AC-7 | roadmap.yaml statuses UPPERCASE | ✅ PASS — all canonical values |
| AC-8 | Zero residual mixed-case | ✅ PASS — COUNT = 0 |

## Verified Details

- **Trigger:** trg_normalize_proposal_status (enabled, BEFORE INSERT OR UPDATE OF status)
- **Constraint:** proposal_status_canonical CHECK with all 28 reference_terms values
- **Code guard:** proposal-storage-v2.ts:342 — `initialStatus = initialStatus.toUpperCase()`
- **pipeline-cron.ts:1278:** LOWER() preserved for cross-table comparison with transition_queue.to_stage (intentional, out of scope)
- **Orchestrator:** running, no dispatch errors

## Verdict

**8/8 PASS — SHIP**

No regressions detected. Three-phase fix (DB migration, code cleanup, input guard) fully verified.
