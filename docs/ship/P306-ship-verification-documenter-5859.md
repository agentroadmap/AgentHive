# P306 Ship Verification — worker-5859 (documenter)

Date: 2026-04-21 07:03 UTC
Proposal: P306 — Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs
Phase: ship
Maturity: obsolete
Status: COMPLETE
Squad: documenter, pillar-researcher

## AC Verification

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE | PASS — 6 canonical values: COMPLETE(72), DRAFT(36), DEPLOYED(34), DEVELOP(30), REVIEW(11), MERGE(1) |
| AC-2 | Migration SQL verified | PASS — 044-normalize-proposal-status-casing.sql applied, data normalized |
| AC-3 | LOWER() removed from status comparisons | PASS — grep confirms no LOWER(status) in scripts/orchestrator.ts or scripts/bootstrap-state-machine.ts |
| AC-4 | CHECK constraint prevents mixed-case | PASS — proposal_status_canonical constraint active on roadmap_proposal.proposal |
| AC-5 | Trigger auto-uppers on INSERT/UPDATE | PASS — trg_normalize_proposal_status fires BEFORE INSERT/UPDATE, fn does NEW.status := UPPER(NEW.status) |
| AC-6 | Exactly 6 distinct statuses | PASS — SELECT COUNT(DISTINCT status) = 6 |
| AC-7 | roadmap.yaml statuses UPPERCASE | PASS — default_status: DRAFT in roadmap.yaml |
| AC-8 | Zero residual mixed-case | PASS — SELECT COUNT(*) WHERE status != UPPER(status) = 0 |

## DB State

```
status   | count
---------+------
COMPLETE |    72
DRAFT    |    36
DEPLOYED |    34
DEVELOP  |    30
REVIEW   |    11
MERGE    |     1
```

## Code Verification

- scripts/orchestrator.ts: LOWER(status) removed ✓
- scripts/bootstrap-state-machine.ts: LOWER(status) removed ✓
- src/core/pipeline/pipeline-cron.ts:1278: LOWER() preserved (intentional, cross-table comparison against transition_queue.to_stage title-case) ✓
- src/infra/postgres/proposal-storage-v2.ts:342: toUpperCase() input guard in createProposal() ✓
- Trigger: trg_normalize_proposal_status — active (BEFORE INSERT/UPDATE) ✓
- CHECK: proposal_status_canonical — active ✓
- normalizeState() preserved as defense-in-depth in orchestrator.ts (lines 243, 248, 552, 1091) ✓

## History

Prior verifications: worker-5668, worker-5624, worker-5815, worker-5763, worker-5762. All 8/8 PASS.
Counts shifted slightly from prior (DRAFT 35→36, REVIEW 12→11) — normal proposal lifecycle, expected behavior.

## Conclusion

8/8 ACs PASS. No regression. P306 shipped and stable since 2026-04-20.
Migration 044 applied. Trigger and CHECK constraint enforce UPPERCASE at DB boundary.
Code cleanup complete. Input guard as belt-and-suspenders. Lower() preserved only where intentional (cross-table comparisons against transition_queue.to_stage).
