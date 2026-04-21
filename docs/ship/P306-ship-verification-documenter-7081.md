# P306 Ship Verification — Documenter (worker-7081)

**Date:** 2026-04-21
**Proposal:** P306 — Normalize proposal status casing
**Phase:** COMPLETE (obsolete)
**Role:** documenter

## Acceptance Criteria Verification

| # | Criteria | Result | Evidence |
|---|----------|--------|----------|
| 1 | All proposal.status UPPERCASE | PASS | COMPLETE(94), DEPLOYED(1), DEVELOP(32), DRAFT(49), REVIEW(8) |
| 2 | Zero residual mixed-case | PASS | `WHERE status != UPPER(status)` → 0 rows |
| 3 | Distinct statuses = canonical set | PASS | 5 distinct (MERGE absent — proposals advanced past it) |
| 4 | Trigger functional | PASS | trg_normalize_proposal_status active (tgenabled=O). Test insert: 'Draft' → stored as 'DRAFT' |
| 5 | CHECK constraint functional | PASS | proposal_status_canonical exists |
| 6 | LOWER() removed from orchestrator + bootstrap | PASS | No matches in scripts/orchestrator.ts or scripts/bootstrap-state-machine.ts |
| 7 | LOWER() preserved in pipeline-cron | PASS | Line 1278: `LOWER(p.status) = LOWER(tq.to_stage)` intact |
| 8 | Orchestrator healthy | PASS | agenthive-orchestrator active (running since 07:50, 7h uptime). agenthive-gate-pipeline active |

## Fresh Verification Summary

- Migration 044 stable since 2026-04-20
- All 44 mixed-case proposals normalized to UPPERCASE
- Trigger catches any new title-case inserts before CHECK evaluates
- Code cleanup confirmed: no LOWER() workarounds remain in orchestrator.ts or bootstrap-state-machine.ts
- Intentional LOWER() preserved at pipeline-cron.ts:1278 for cross-table comparison with transition_queue.to_stage
- Orchestrator dispatching normally, no gate loop regressions

## Deliverables

- Design: docs/plans/P306-normalize-status-casing.md
- Migration: database/ddl/v4/044-normalize-proposal-status-casing.sql
- Ship report: docs/ships/P306-ship-report.md

## Verdict

**SHIP CONFIRMED** — P306 is COMPLETE/obsolete. All 8 ACs pass. Migration stable in production. No regressions detected.
