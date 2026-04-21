# P306 Ship Verification — worker-7009 (documenter)

Date: 2026-04-21 14:50 UTC
Proposal: P306 — Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs
Phase: ship
Status: COMPLETE
Role: documenter (independent re-verification)

## AC Verification

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE | PASS — 6 canonical values: COMPLETE(93), DEPLOYED(1), DEVELOP(30), DRAFT(50), MERGE(1), REVIEW(9) |
| AC-2 | Zero residual mixed-case | PASS — WHERE status != UPPER(status) = 0 |
| AC-3 | Exactly 6 distinct statuses | PASS — SELECT COUNT(DISTINCT status) = 6 |
| AC-4 | Trigger auto-upcases on INSERT/UPDATE | PASS — trg_normalize_proposal_status active (BEFORE INSERT/UPDATE) |
| AC-5 | CHECK constraint prevents invalid values | PASS — proposal_status_canonical confirmed (type 'c') |
| AC-6 | LOWER() removed from orchestrator.ts and bootstrap-state-machine.ts | PASS — grep clean, zero matches |
| AC-7 | LOWER() preserved in pipeline-cron.ts:1278 | PASS — line 1278 has LOWER(p.status) = LOWER(tq.to_stage) |
| AC-8 | Phase 3 input guard in place | PASS — proposal-storage-v2.ts:342: initialStatus.toUpperCase() |

## DB State (live at verification time)

```
status   | count
----------+------
COMPLETE |    93
DEPLOYED |     1
DEVELOP  |    30
DRAFT    |    50
MERGE    |     1
REVIEW   |     9
(6 rows)
```

## Infrastructure Verification

- Trigger: `trg_normalize_proposal_status` — fires on INSERT + UPDATE
- Constraint: `proposal_status_canonical` — CHECK type confirmed
- Code cleanup: orchestrator.ts — no LOWER(status) matches
- Code cleanup: bootstrap-state-machine.ts — no LOWER(status) matches
- Input guard: proposal-storage-v2.ts:342 — toUpperCase() confirmed
- normalizeState() retained as defense-in-depth (orchestrator.ts:243)

## History

This is the 21st+ independent ship verification for P306.
Migration 044 stable since 2026-04-20.
Count drift from prior verifications (COMPLETE 72→93, DRAFT 35→50, REVIEW 12→9) is normal proposal lifecycle advancement.

## Conclusion

8/8 ACs PASS. No regression. P306 shipped and stable.
Migration 044 applied. Trigger + CHECK enforce UPPERCASE at DB boundary.
Code cleanup verified. Input guard as belt-and-suspenders.
