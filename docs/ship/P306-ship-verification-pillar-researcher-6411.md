# P306 Ship Verification — worker-6411 (pillar-researcher)

Date: 2026-04-21 10:54 UTC
Proposal: P306 — Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs
Phase: ship
Status: COMPLETE
Maturity: obsolete
Agent: worker-6411 (pillar-researcher)
Squad: documenter, pillar-researcher

## AC Verification

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE | PASS — 6 canonical values: COMPLETE(75), DEPLOYED(34), DEVELOP(31), DRAFT(35), MERGE(1), REVIEW(8) |
| AC-2 | Zero mixed-case residuals | PASS — WHERE status != UPPER(status) = 0 |
| AC-3 | Exactly 6 distinct statuses | PASS — SELECT COUNT(DISTINCT status) = 6 |
| AC-4 | Trigger auto-upcases on INSERT/UPDATE | PASS — trg_normalize_proposal_status enabled (BEFORE INSERT OR UPDATE OF status) |
| AC-5 | CHECK constraint prevents invalid values | PASS — proposal_status_canonical active on roadmap_proposal.proposal |
| AC-6 | LOWER() removed from orchestrator.ts and bootstrap-state-machine.ts | PASS — grep clean across both files |
| AC-7 | LOWER() preserved in pipeline-cron.ts:1278 (intentional cross-table) | PASS — AND LOWER(p.status) = LOWER(tq.to_stage) present |
| AC-8 | Input guard: toUpperCase() in createProposal | PASS — proposal-storage-v2.ts:342: initialStatus = initialStatus.toUpperCase() |

## Live DB State

```
status   | count
---------+------
COMPLETE |    75
DEPLOYED |    34
DEVELOP  |    31
DRAFT    |    35
MERGE    |     1
REVIEW   |     8
```

6 distinct statuses. 0 mixed-case rows. All UPPERCASE.

## Trigger Smoke Test

Tested INSERT with 'Draft' (title-case). Trigger converted to 'DRAFT' (uppercase).
Row in error message confirms: `...issue, DRAFT, Trigger test...` — trigger fires before CHECK.
Insert failed only on unrelated audit NOT NULL constraint.

## Code Verification

- scripts/orchestrator.ts: LOWER(status) removed ✓
- scripts/bootstrap-state-machine.ts: LOWER(status) removed ✓
- src/infra/postgres/proposal-storage-v2.ts:342 toUpperCase() input guard ✓
- database/ddl/v4/044-normalize-proposal-status-casing.sql: migration applied ✓
- Trigger: trg_normalize_proposal_status — enabled (O) ✓
- CHECK: proposal_status_canonical — active ✓
- src/core/pipeline/pipeline-cron.ts:1278: LOWER() preserved for cross-table to_stage comparison ✓

## Other LOWER() Usage (Intentional, Not Bugs)

- Migration scripts 020, 029, 030, 033: Historical SQL, already executed. Not runtime code.
- proposal-storage-v2.ts:516-517,570: LOWER on proposal_valid_transitions columns (from_state, to_state) — cross-table comparison, not proposal.status. Intentional.

## Delta from Prior Verifications

Prior verification (worker-6286, 14:04 UTC): COMPLETE=74, REVIEW=8.
Current (worker-6411, 10:54 UTC): COMPLETE=75, REVIEW=8.
Normal lifecycle movement (+1 COMPLETE). No regression.

## Conclusion

8/8 ACs PASS. No regression. P306 shipped and stable since 2026-04-20.
Migration 044 applied. Trigger + CHECK constraint enforce UPPERCASE at DB boundary.
Code cleanup complete. Input guard as defense-in-depth.
Skeptic review conditions all addressed.

Ship verdict: APPROVED.
