# Gate Decisions — 2026-04-11

Reviewed by: hermes-agent (cron - RFC Gate Evaluator)
Timestamp: 2026-04-11T10:47:20.770813+00:00

## Summary

| Proposal | Decision | Reason |
|----------|----------|--------|
| P159 | HOLD | FIX maturity=new, no AC defined, no notes — not ready for DEPLOYED |
| P160 | HOLD | FIX maturity=new, no AC defined, no notes — not ready for DEPLOYED |
| P161 | HOLD | FIX maturity=new, no AC defined, no notes — not ready for DEPLOYED |
| P048 | HOLD | DEVELOP maturity=active, AC all pending — not ready for MERGE |

## Quick Fix Workflow

### TRIAGE → FIX
No proposals in TRIAGE state.

### FIX → DEPLOYED

#### P159 — crypto identity not linked to DB
- **State:** FIX
- **Type:** issue
- **Maturity:** new
- **Acceptance Criteria:** None defined
- **Decision:** HOLD

**Rationale:** Proposal maturity is "new" and no acceptance criteria are defined. Cannot advance to DEPLOYED without AC and maturity=mature.

#### P160 — dead code since 2026-04-01
- **State:** FIX
- **Type:** issue
- **Maturity:** new
- **Acceptance Criteria:** None defined
- **Decision:** HOLD

**Rationale:** Proposal maturity is "new" and no acceptance criteria are defined. Cannot advance to DEPLOYED without AC and maturity=mature.

#### P161 — seed-proposals, cli, ws-bridge variants
- **State:** FIX
- **Type:** issue
- **Maturity:** new
- **Acceptance Criteria:** None defined
- **Decision:** HOLD

**Rationale:** Proposal maturity is "new" and no acceptance criteria are defined. Cannot advance to DEPLOYED without AC and maturity=mature.

## RFC Workflow

### DRAFT → REVIEW
No proposals in DRAFT state.

### REVIEW → DEVELOP
No proposals in REVIEW state.

### DEVELOP → MERGE

#### P048 — CLI, MCP Server & Federation
- **State:** DEVELOP
- **Type:** component
- **Maturity:** active
- **Acceptance Criteria:** Defined (10+ AC items) — ALL ⏳ pending (none verified)
- **Decision:** HOLD

**Rationale:** Acceptance criteria are defined but all are pending verification. Maturity is "active" (not yet "mature"). Gate requires maturity=mature AND all AC verified before advancing to MERGE.

### MERGE → COMPLETE
No proposals in MERGE state.

---

## Notes

- 17 total proposals in system: 9 COMPLETE, 4 DEPLOYED, 1 DEVELOP, 3 FIX
- No DRAFT, REVIEW, or MERGE proposals pending
- FIX proposals (P159-P161) need AC definitions and work before they can advance
- P048 needs AC verification and maturity advancement before MERGE gate
