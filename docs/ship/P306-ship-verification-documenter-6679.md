# P306 Ship Verification — worker-6679 (documenter)

**Date:** 2026-04-21
**Phase:** COMPLETE / Ship
**Agent:** worker-6679 (documenter)
**Proposal:** P306 — Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs

## Problem Summary

Live database had 10 distinct status values with mixed casing (DRAFT vs Draft, REVIEW vs Review, etc.). 44 proposals had title-case status values that bypassed uppercase filters, causing gate loops, missed dispatches, and board display inconsistencies.

## Solution

Three-phase fix:

1. **DB Migration (044):** Normalize all existing data to UPPERCASE, add trigger `trg_normalize_proposal_status` to auto-uppercase on INSERT/UPDATE, add CHECK constraint `proposal_status_canonical`.
2. **Code Cleanup:** Remove LOWER() workarounds from orchestrator.ts and bootstrap-state-machine.ts.
3. **Input Guard:** `toUpperCase()` in createProposal() before INSERT.

## Acceptance Criteria Verification

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE in live DB | PASS — 6 canonical values: COMPLETE(77), DEPLOYED(34), DEVELOP(28), DRAFT(35), MERGE(2), REVIEW(8) |
| AC-2 | Zero residual mixed-case | PASS — WHERE status != UPPER(status) = 0 |
| AC-3 | Exactly 6 distinct statuses | PASS — SELECT COUNT(DISTINCT status) = 6 |
| AC-4 | Trigger auto-upcases on INSERT/UPDATE | PASS — trg_normalize_proposal_status fires BEFORE INSERT/UPDATE (tgenabled='O') |
| AC-5 | CHECK constraint prevents invalid values | PASS — proposal_status_canonical (contype='c') confirmed |
| AC-6 | LOWER() removed from orchestrator.ts and bootstrap-state-machine.ts | PASS — grep returns zero matches |
| AC-7 | LOWER() preserved in pipeline-cron.ts:1278 | PASS — intentional cross-table comparison with transition_queue.to_stage |
| AC-8 | Phase 3 input guard in createProposal() | PASS — proposal-storage-v2.ts:342: `initialStatus = initialStatus.toUpperCase()` |

**Verdict: 8/8 PASS**

## Live DB State

```
 status   | count
----------+------
 COMPLETE |    77
 DEPLOYED |    34
 DEVELOP  |    28
 DRAFT    |    35
 MERGE    |     2
 REVIEW   |     8
```

Total proposals: 184. 6 distinct statuses. 0 mixed-case rows.

## Artifacts

| File | Description |
|------|-------------|
| `database/ddl/v4/044-normalize-proposal-status-casing.sql` | Migration: normalize data + trigger + CHECK constraint |
| `docs/plans/P306-normalize-status-casing.md` | Design document (209 lines) |
| `docs/ship/P306-normalize-status-casing.md` | Main ship document (SHIPPED) |

## Code Changes

| File | Change |
|------|--------|
| `scripts/orchestrator.ts` | Removed LOWER(status) — now uses `p.status IN ('DRAFT','REVIEW','DEVELOP','MERGE')` |
| `scripts/bootstrap-state-machine.ts` | Removed LOWER(status) at lines 45, 105 |
| `src/core/pipeline/pipeline-cron.ts` | LOWER() preserved at line 1278 — intentional cross-table comparison with transition_queue.to_stage (title-case) |
| `src/infra/postgres/proposal-storage-v2.ts` | Added `toUpperCase()` input guard at line 342 |

## Reviews

6 approvals received:
- hermes-andy (skeptic-beta approve with minor conditions)
- worker-4681 (approve)
- hermes/agency-xiaomi/worker-5860 (ship approve — pillar-researcher)
- worker-6286 (approve)
- worker-6474 (approve)
- hermes (approve)

## Design Decisions

1. **terminology.ts kept as title-case (display layer).** Trigger normalizes at DB boundary. Title-case is correct for TUI/board/Discord.
2. **transition_queue.to_stage kept title-case.** 98.7% of 6,631 rows are title-case. LOWER() comparison handles cross-table correctly. Normalizing to_stage requires 12+ file changes — separate effort.
3. **CHECK constraint lists both cases.** Trigger fires BEFORE CHECK, so only UPPERCASE reaches column. Listing both forms provides clear error messages if trigger is bypassed.

## Conclusion

P306 fully shipped and stable since 2026-04-20. All 8 ACs pass. No regression detected. Mixed-case status filtering bugs eliminated at root cause (DB data) with defense-in-depth layers (trigger, CHECK, input guard, normalizeState()).
