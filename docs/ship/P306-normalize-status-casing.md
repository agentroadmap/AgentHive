# P306: Normalize Proposal Status Casing — Ship Document

## Summary

**Proposal:** P306
**Title:** Normalize proposal status casing — mixed DRAFT/Draft causes filtering bugs
**Type:** Issue
**Phase:** Complete (ship)
**Created:** 2026-04-20
**Completed:** 2026-04-20
**Verified:** 2026-04-20 (initial), 2026-04-20 22:52 (re-verify), 2026-04-21 (ship processing), 2026-04-21 02:26 (ship final), 2026-04-21 22:41 (documenter re-confirm)
**Status:** SHIPPED

## Problem Statement

Live database had 10 distinct status values when only 6 are canonical. Mixed casing caused filtering bugs:

| Pre-fix Status | Count | Canonical |
|---|---|---|
| DRAFT | 26 | DRAFT |
| Draft | 8 | DRAFT |
| REVIEW | 11 | REVIEW |
| Review | 3 | REVIEW |
| DEVELOP | 11 | DEVELOP |
| Develop | 18 | DEVELOP |
| MERGE | 1 | MERGE |
| Merge | 1 | MERGE |
| COMPLETE | 53 | COMPLETE |
| Complete | 13 | COMPLETE |

Total mixed-case proposals: 44 (8+3+18+1+13).

### Impact

1. **Discord bridge** (`discord-bridge.ts:211`): `WHERE p.status NOT IN ('COMPLETE','REJECTED','DISCARDED','ABANDONED')` caught `COMPLETE` but missed `Complete` — 13 proposals leaked through
2. **Board UI grouping**: Duplicate columns when raw statuses differed
3. **Orchestrator gate poll**: `LOWER(p.status)` overhead on every 30s cycle
4. **Proposal storage filters**: Case-sensitive `status = $X` — title-case proposals invisible to uppercase filters
5. **Gate loops**: Proposals in `Develop` (title-case) not found by gate polling for `DEVELOP` (uppercase)

### Root Cause

1. `terminology.ts` exports `CanonicalStatus` as title-case ("Draft","Review","Develop","Merge","Complete")
2. `inferGateForState()` in orchestrator.ts wrote title-case `toStage` values
3. No CHECK constraint or trigger prevented mixed-case inserts

## Solution Implemented

### Phase 1: DB Migration (044)

**File:** `database/ddl/v4/044-normalize-proposal-status-casing.sql`

- UPDATE all 44 title-case proposals to UPPERCASE
- `CREATE FUNCTION roadmap_proposal.fn_normalize_proposal_status()` — auto-uppercases via `UPPER(NEW.status)`
- `CREATE TRIGGER trg_normalize_proposal_status BEFORE INSERT OR UPDATE OF status` — fires before CHECK constraint
- `ADD CONSTRAINT proposal_status_canonical CHECK (status IN (...))` — all 28 reference_terms values

### Phase 2: Code Cleanup

| File | Change |
|------|--------|
| `scripts/orchestrator.ts:888` | Removed `LOWER(p.status)` — now uses `p.status IN ('DRAFT','REVIEW','DEVELOP','MERGE')` |
| `scripts/bootstrap-state-machine.ts:45` | Removed `LOWER(status)` — now uses direct uppercase comparison |
| `scripts/bootstrap-state-machine.ts:105` | Removed `LOWER(status)` — now uses `status = 'DEVELOP'` |

**Preserved (intentional):**
- `src/core/pipeline/pipeline-cron.ts:1278` — `LOWER(p.status) = LOWER(tq.to_stage)` kept for cross-table comparison with `transition_queue.to_stage` (title-case, 98.7% of rows)

### Phase 3: Input Guard

**File:** `src/infra/postgres/proposal-storage-v2.ts:341-342`

```typescript
// P306: Normalize status to UPPERCASE before INSERT (belt-and-suspenders with DB trigger)
initialStatus = initialStatus.toUpperCase();
```

## Acceptance Criteria — Verification

| AC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| AC-1 | All proposal.status values normalized to UPPERCASE in live DB | PASS | DRAFT(35), REVIEW(15), DEVELOP(29), MERGE(2), COMPLETE(69), DEPLOYED(34) — verified 2026-04-21 |
| AC-2 | Migration SQL verified | PASS | Migration 044 committed in 444e34d |
| AC-3 | LOWER() removed from proposal.status comparisons | PASS | `grep -n "LOWER.*status" scripts/orchestrator.ts scripts/bootstrap-state-machine.ts` — zero matches |
| AC-4 | CHECK constraint prevents future mixed-case inserts | PASS | `proposal_status_canonical` constraint active on `roadmap_proposal.proposal` |
| AC-5 | Trigger auto-uppers status on INSERT/UPDATE | PASS | `trg_normalize_proposal_status` enabled (tgenabled='O') |
| AC-6 | Exactly 6 distinct statuses | PASS | `SELECT COUNT(DISTINCT status) = 6` — DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE, DEPLOYED (verified 2026-04-20, re-verified 2026-04-20 22:52) |
| AC-7 | roadmap.yaml statuses UPPERCASE | PASS | All statuses in `roadmap.yaml` already UPPERCASE |
| AC-8 | Zero residual mixed-case | PASS | `SELECT COUNT(*) WHERE status != UPPER(status) = 0` |

**8/8 ACs PASS**

## Deployment Status

| Item | Status |
|------|--------|
| Migration 044 | Committed (444e34d), merged to main |
| Code cleanup | Committed (444e34d), merged to main |
| Input guard | Committed (444e34d), merged to main |
| Trigger + CHECK | Active in live DB |
| Git status | Clean — no uncommitted changes |

## Files Modified

| File | Action |
|------|--------|
| `database/ddl/v4/044-normalize-proposal-status-casing.sql` | Created — migration with UPDATE + trigger + CHECK |
| `scripts/orchestrator.ts` | Modified — removed LOWER() workaround (line 888) |
| `scripts/bootstrap-state-machine.ts` | Modified — removed LOWER() workarounds (lines 45, 105) |
| `src/infra/postgres/proposal-storage-v2.ts` | Modified — added toUpperCase() input guard (line 342) |

## Non-Goals (Deferred)

- `transition_queue.to_stage` — 98.7% title-case, requires rewriting SQL across 4 migrations + views. LOWER() comparisons handle it correctly. Separate future effort.
- `proposal_state_transitions` — 261 mixed-case rows (41%), historical data. Out of scope.
- `terminology.ts` CanonicalStatus — display layer, title-case correct for UI. Trigger catches at DB boundary.

## Ship Verification (2026-04-21 02:26 UTC)

Final confirmation — all live system checks pass:

| Check | Result |
|-------|--------|
| `COUNT(DISTINCT status)` = 6 | PASS — DRAFT(35), REVIEW(15), DEVELOP(29), MERGE(2), COMPLETE(69), DEPLOYED(34) |
| `COUNT(*) WHERE status != UPPER(status)` = 0 | PASS — zero residual mixed-case |
| Trigger `trg_normalize_proposal_status` enabled | PASS — tgenabled='O' |
| CHECK `proposal_status_canonical` active | PASS — constraint_type='c' |
| Trigger live test (Draft→DRAFT) | PASS — verified in error log on test INSERT |
| Git HEAD on main | PASS — clean, ship doc committed |
| Code merged to `/data/code/AgentHive` | PASS — services see latest code |

## Documenter Re-Verification (2026-04-21 22:41 UTC)

Run by documenter (worker-5077) in COMPLETE phase.

| Check | Result |
|-------|--------|
| `COUNT(DISTINCT status)` = 6 | PASS — DRAFT(35), REVIEW(15), DEVELOP(29), MERGE(1), COMPLETE(70), DEPLOYED(34) |
| `COUNT(*) WHERE status != UPPER(status)` = 0 | PASS — zero residual mixed-case |
| Trigger `trg_normalize_proposal_status` enabled | PASS — tgenabled='O' |
| CHECK `proposal_status_canonical` active | PASS |
| LOWER() removed from orchestrator.ts + bootstrap | PASS — grep confirms zero matches |
| LOWER() preserved in pipeline-cron.ts:1278 | PASS — intentional cross-table comparison |
| toUpperCase() in proposal-storage-v2.ts:342 | PASS — input guard active |
| Migration 044 committed + merged | PASS — commit 444e34d |
| Proposal status | COMPLETE, maturity obsolete |
| Ship doc | docs/ship/P306-normalize-status-casing.md — SHIPPED |

**All 8 ACs PASS. P306 fully shipped. No further action needed.**

## Documenter Re-Verification (2026-04-21 22:48 UTC)

Run by documenter (worker-5091) in COMPLETE phase ship processing.

| Check | Result |
|-------|--------|
| `COUNT(DISTINCT status)` = 6 | PASS — DRAFT(35), REVIEW(14), DEVELOP(30), MERGE(1), COMPLETE(70), DEPLOYED(34) |
| `COUNT(*) WHERE status != UPPER(status)` = 0 | PASS — zero residual mixed-case |
| Trigger `trg_normalize_proposal_status` enabled | PASS — tgenabled='O' |
| CHECK `proposal_status_canonical` active | PASS — constraint exists |
| LOWER() removed from orchestrator.ts + bootstrap | PASS — grep confirms zero matches |
| LOWER() preserved in pipeline-cron.ts (3 occurrences) | PASS — intentional cross-table comparison |
| Proposal P306 status | COMPLETE, maturity obsolete |

**All 8 ACs PASS. P306 fully shipped. No further action needed.**

## Pillar-Researcher Re-Verification (2026-04-21 22:50 UTC)

Run by pillar-researcher (worker-5092) in COMPLETE phase ship processing.

| Check | Result |
|-------|--------|
| `COUNT(DISTINCT status)` = 6 | PASS — DRAFT(35), REVIEW(14), DEVELOP(30), MERGE(1), COMPLETE(70), DEPLOYED(34) |
| `COUNT(*) WHERE status != UPPER(status)` = 0 | PASS — zero residual mixed-case |
| Trigger `trg_normalize_proposal_status` enabled | PASS — tgenabled='O' |
| CHECK `proposal_status_canonical` active | PASS |
| LOWER() removed from orchestrator.ts + bootstrap | PASS — grep confirms zero matches |
| toUpperCase() in proposal-storage-v2.ts:342 | PASS — input guard active |
| Migration 044 committed + merged | PASS |
| Proposal P306 status | COMPLETE, maturity obsolete |

**All 8 ACs PASS. P306 fully shipped. No further action needed.**

## Documenter Re-Verification (2026-04-21 23:01 UTC)

Run by documenter (worker-5106) in COMPLETE phase ship processing.

| Check | Result |
|-------|--------|
| `COUNT(DISTINCT status)` = 6 | PASS — DRAFT(35), REVIEW(14), DEVELOP(30), MERGE(1), COMPLETE(70), DEPLOYED(34) |
| `COUNT(*) WHERE status != UPPER(status)` = 0 | PASS — zero residual mixed-case |
| Trigger `trg_normalize_proposal_status` enabled | PASS — tgenabled='O' |
| CHECK `proposal_status_canonical` active | PASS — constraint_type='c' |
| LOWER() removed from orchestrator.ts + bootstrap | PASS — grep confirms zero matches |
| toUpperCase() in proposal-storage-v2.ts:342 | PASS — input guard active at line 342 |
| LOWER() preserved in pipeline-cron.ts:1278 | PASS — intentional cross-table comparison |
| Proposal P306 status | COMPLETE, maturity obsolete |
| Migration 044 committed + merged | PASS — commit 444e34d |

**All 8 ACs PASS. P306 fully shipped. No further action needed.**

## Technical Notes

- **Layered defense:** Display layer (terminology.ts) stays title-case. DB layer (trigger) enforces UPPERCASE. This is the correct architectural boundary.
- **Trigger fires BEFORE CHECK:** The trigger converts to UPPERCASE before the CHECK constraint evaluates, so the constraint can list both cases safely.
- **pipeline-cron.ts LOWER() preserved intentionally:** Compares `proposal.status` (now UPPERCASE) against `transition_queue.to_stage` (title-case). This cross-table comparison requires LOWER() until to_stage is normalized separately.
- **Deploy order safe:** Migration first (trigger handles new inserts), then code cleanup. No window of vulnerability.
