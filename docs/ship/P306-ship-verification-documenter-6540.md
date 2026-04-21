# P306 Ship Verification — documenter worker-6540

**Date:** 2026-04-21 11:45 UTC
**Agent:** hermes/agency-xiaomi/worker-6540 (documenter)
**Phase:** ship (COMPLETE)
**Maturity:** obsolete
**Status:** COMPLETE

## AC Verification (8/8 PASS)

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | All proposal.status values UPPERCASE | PASS — COMPLETE(75), DEPLOYED(34), DEVELOP(29), DRAFT(35), MERGE(3), REVIEW(8) |
| AC-2 | Zero residual mixed-case | PASS — SELECT COUNT(*) WHERE status != UPPER(status) = 0 |
| AC-3 | Exactly 6 distinct statuses | PASS — COUNT(DISTINCT status) = 6 |
| AC-4 | Trigger auto-upcases on INSERT/UPDATE | PASS — trg_normalize_proposal_status active (tgenabled='O'), fires BEFORE INSERT/UPDATE |
| AC-5 | CHECK constraint prevents invalid values | PASS — proposal_status_canonical active (CHECK) |
| AC-6 | LOWER() removed from orchestrator.ts and bootstrap-state-machine.ts | PASS — grep clean on both files |
| AC-7 | LOWER() preserved in pipeline-cron.ts:1278 | PASS — intentional cross-table comparison LOWER(p.status) = LOWER(tq.to_stage) |
| AC-8 | Phase 3 input guard in createProposal | PASS — proposal-storage-v2.ts:342: initialStatus.toUpperCase() |

## Infrastructure Verified

- **Migration:** database/ddl/v4/044-normalize-proposal-status-casing.sql (52 lines, applied)
- **Trigger:** trg_normalize_proposal_status — BEFORE INSERT OR UPDATE OF status, fires UPPER()
- **Constraint:** proposal_status_canonical — CHECK on all reference_terms proposal_state values
- **Input guard:** proposal-storage-v2.ts:342 — toUpperCase() before INSERT
- **Orchestrator:** agenthive-orchestrator service active (running), no dispatch errors
- **Gate pipeline:** agenthive-gate-pipeline service active (running)
- **MCP server:** agenthive-mcp service active (running)

## Code Audit

| File | LOWER(status) | Expected |
|------|---------------|----------|
| scripts/orchestrator.ts | NONE | Yes — cleaned in Phase 2 |
| scripts/bootstrap-state-machine.ts | NONE | Yes — cleaned in Phase 2 |
| src/core/pipeline/pipeline-cron.ts:1278 | LOWER(p.status) = LOWER(tq.to_stage) | Yes — intentional cross-table |
| src/infra/postgres/proposal-storage-v2.ts:342 | toUpperCase() guard | Yes — Phase 3 input guard |

## Prior Verifications

- worker-5860 (pillar-researcher): all 8 ACs PASS, ship approved
- worker-4681: approve
- hermes-andy (skeptic-beta): approve with minor conditions (AC tightening, rollback docs)
- worker-6012 (pillar-researcher): all 8 ACs PASS
- worker-623 (documenter): all 8 ACs PASS
- worker-5668 (documenter): all 8 ACs PASS
- worker-6063 (documenter): all 8 ACs PASS

## Verdict

**SHIP CONFIRMED.** P306 has been stable since 2026-04-20. All 8 ACs pass with live DB verification (7th ship cycle). Proposal is COMPLETE/obsolete — fully shipped and locked.
