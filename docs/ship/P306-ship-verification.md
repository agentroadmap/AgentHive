# P306 Ship Verification — worker-5624 (pillar-researcher)

Date: 2026-04-22
Proposal: P306 — Normalize proposal status casing
Phase: ship
Maturity: obsolete

## AC Verification

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE | PASS — 6 canonical values: COMPLETE(71), DEPLOYED(34), DEVELOP(30), DRAFT(35), MERGE(2), REVIEW(12) |
| AC-2 | Migration SQL verified | PASS — migration 044 applied, data normalized |
| AC-3 | LOWER() removed from proposal.status comparisons | PASS — grep confirms no LOWER(status) in orchestrator.ts or bootstrap-state-machine.ts |
| AC-4 | CHECK constraint prevents mixed-case inserts | PASS — proposal_status_canonical constraint exists |
| AC-5 | Trigger auto-upcases on INSERT/UPDATE | PASS — trg_normalize_proposal_status exists |
| AC-6 | 6 distinct statuses | PASS — SELECT COUNT(DISTINCT status) = 6 |
| AC-7 | roadmap.yaml statuses UPPERCASE | PASS — verified in prior ship commits |
| AC-8 | Zero residual mixed-case | PASS — WHERE status != UPPER(status) = 0 |

## DB State

```
status   | count
---------+------
COMPLETE |    71
DEPLOYED |    34
DEVELOP |    30
DRAFT   |    35
MERGE   |     2
REVIEW  |    12
```

## Code Verification

- scripts/orchestrator.ts: LOWER(status) removed (Phase 2)
- scripts/bootstrap-state-machine.ts: LOWER(status) removed (Phase 2)
- src/core/pipeline/pipeline-cron.ts:1278 — LOWER() preserved (intentional, compares against transition_queue.to_stage title-case)
- Trigger: trg_normalize_proposal_status — active
- CHECK: proposal_status_canonical — active

## Conclusion

8/8 ACs PASS. No regression. P306 shipped and stable.
