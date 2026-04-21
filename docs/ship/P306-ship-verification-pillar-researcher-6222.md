# P306 Ship Verification — worker-6222 (pillar-researcher)

Date: 2026-04-21 09:37 UTC
Proposal: P306 — Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs
Phase: ship
Status: COMPLETE
Maturity: obsolete

## AC Verification

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE | PASS — 6 canonical values: COMPLETE(74), DEPLOYED(34), DEVELOP(31), DRAFT(35), MERGE(1), REVIEW(9) |
| AC-2 | Migration SQL normalizes data | PASS — WHERE status != UPPER(status) = 0 |
| AC-3 | LOWER() removed from orchestrator.ts and bootstrap-state-machine.ts | PASS — grep clean |
| AC-4 | CHECK constraint prevents invalid values | PASS — proposal_status_canonical active |
| AC-5 | Trigger auto-upcases on INSERT/UPDATE | PASS — trg_normalize_proposal_status enabled |
| AC-6 | 6 distinct statuses | PASS — SELECT COUNT(DISTINCT status) = 6 |
| AC-7 | Input guard: toUpperCase() in createProposal | PASS — proposal-storage-v2.ts:342 |
| AC-8 | No residual mixed-case | PASS — 0 rows where status != UPPER(status) |

## DB State

```
status   | cnt
---------+-----
COMPLETE |  74
DEPLOYED |  34
DEVELOP  |  31
DRAFT    |  35
MERGE    |   1
REVIEW   |   9
```

6 distinct statuses. 0 mixed-case rows.

## Code Verification

- src/orchestrator/orchestrator.ts: LOWER(status) removed ✓
- src/core/state-machine/bootstrap-state-machine.ts: LOWER(status) removed ✓
- src/infra/postgres/proposal-storage-v2.ts:342: toUpperCase() input guard ✓
- database/ddl/v4/044-normalize-proposal-status-casing.sql: migration applied ✓
- Trigger: trg_normalize_proposal_status — enabled ✓
- CHECK: proposal_status_canonical — active ✓

## Delta from Prior Verifications

COMPLETE 72→74, REVIEW 12→9 — normal proposal lifecycle movement. No regression.
Prior verifications: worker-5860 (skeptic-beta, approve), worker-5624, worker-5668.

## Conclusion

8/8 ACs PASS. No regression. P306 shipped and stable since 2026-04-20.
Migration 044 applied. Trigger + CHECK constraint enforce UPPERCASE at DB boundary.
Code cleanup complete. Input guard as defense-in-depth.
