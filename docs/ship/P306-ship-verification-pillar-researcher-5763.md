# P306 Ship Verification — worker-5763 (pillar-researcher)

Date: 2026-04-21 06:23 UTC
Proposal: P306 — Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs
Phase: ship
Maturity: obsolete
Status: COMPLETE
Squad: documenter, pillar-researcher

## AC Verification

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE | PASS — 6 canonical values: COMPLETE(72), DEPLOYED(34), DEVELOP(30), DRAFT(36), MERGE(1), REVIEW(11) |
| AC-2 | Zero residual mixed-case | PASS — WHERE status != UPPER(status) = 0 |
| AC-3 | Exactly 6 distinct statuses | PASS — SELECT COUNT(DISTINCT status) = 6 |
| AC-4 | Trigger auto-upcases on INSERT/UPDATE | PASS — trg_normalize_proposal_status active (enabled=O, BEFORE INSERT/UPDATE) |
| AC-5 | CHECK constraint prevents invalid values | PASS — proposal_status_canonical active |
| AC-6 | LOWER() removed from orchestrator.ts and bootstrap-state-machine.ts | PASS — grep clean |
| AC-7 | LOWER() preserved in pipeline-cron.ts:1278 (intentional cross-table) | PASS — line 1278 has LOWER(p.status) = LOWER(tq.to_stage) |
| AC-8 | Phase 3 input guard in place | PASS — proposal-storage-v2.ts:342: initialStatus.toUpperCase() |

## DB State

```
status   | count
---------+------
COMPLETE |    72
DEPLOYED |    34
DEVELOP  |    30
DRAFT    |    36
MERGE    |     1
REVIEW   |    11
```

## Code Verification

- scripts/orchestrator.ts: LOWER(status) removed ✓
- scripts/bootstrap-state-machine.ts: LOWER(status) removed ✓
- src/core/pipeline/pipeline-cron.ts:1278: LOWER() preserved (intentional, cross-table comparison against transition_queue.to_stage) ✓
- src/infra/postgres/proposal-storage-v2.ts:342: toUpperCase() input guard ✓
- Trigger: trg_normalize_proposal_status — active (enabled=O) ✓
- CHECK: proposal_status_canonical — active ✓

## History

Prior verifications: worker-5718 (documenter, 2026-04-21 06:03), hermes (pillar-researcher, 2026-04-21 05:44), worker-5668, worker-5624. All pass.
Counts stable: DRAFT 36, REVIEW 11, MERGE 1 — minor drift from proposal lifecycle, expected.

## Conclusion

8/8 ACs PASS. No regression. P306 shipped and stable since 2026-04-20.
Migration 044 applied. Trigger and CHECK constraint enforce UPPERCASE at DB boundary.
Code cleanup complete. Input guard as belt-and-suspenders. LOWER() preserved only where intentional (cross-table).
