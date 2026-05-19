# Gate Enforcement — Operator Guide (P290)

**Proposal:** P290 — Gate enforcement: status advancement requires gate_decision_log entry  
**Status:** COMPLETE  
**Migration:** `scripts/migrations/040-p290-gate-enforcement.sql`  
**Last revised:** 2026-05-09

---

## 1. What was built

Before P290, proposals could jump from `DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE` without any gate agent review being recorded. The `gate_decision_log` table (created by P167 / migration `018-gate-decision-audit.sql`) existed but was never checked at transition time. Gate decisions accumulated as unstructured `proposal_event` rows instead.

P290 closes that gap with a **PostgreSQL BEFORE UPDATE trigger** that rejects any forward status advancement on the four gated transitions unless a qualifying decision record is present within the last 10 minutes.

---

## 2. Gated transitions (D1–D4)

| Gate | Transition | Meaning |
|:-----|:-----------|:--------|
| D1 | `DRAFT → REVIEW` | Architecture sign-off |
| D2 | `REVIEW → DEVELOP` | Feasibility + AC completeness |
| D3 | `DEVELOP → MERGE` | Build quality + test coverage |
| D4 | `MERGE → COMPLETE` | Integration stability |

All other transitions (backward rollbacks, re-opening, etc.) are **not** intercepted.

---

## 3. How the trigger works

**Function:** `roadmap_proposal.fn_guard_gate_advance()`  
**Trigger:** `trg_guard_gate_advance` — `BEFORE UPDATE OF status ON roadmap_proposal.proposal FOR EACH ROW`

On every forward status update the trigger:

1. Derives the gate key (`DRAFT→REVIEW`, `REVIEW→DEVELOP`, …).  
2. If the key is not one of D1–D4, passes immediately.  
3. If `current_setting('app.gate_bypass', true) = 'true'`, passes immediately (see §5).  
4. Checks `gate_decision_log` for a row where `decision='advance'` AND `(proposal_id, from_state, to_state)` match AND `created_at >= now() - INTERVAL '10 minutes'`.  
5. If no advance entry found, checks `proposal_reviews` for `verdict='approve'` within the same 10-minute window.  
6. If neither check passes, raises `SQLSTATE 23514` (`check_violation`) with a human-readable message:

```
Gate transition DRAFT → REVIEW on proposal 42 requires a gate decision.
Submit a gate review (proposal_reviews verdict=approve) or
gate_decision_log (decision=advance) within the last 10 minutes before advancing.
```

---

## 4. Approval paths

Two independent paths both satisfy the guard:

| Path | Table | Column | Value | Written by |
|:-----|:------|:-------|:------|:-----------|
| **Primary** | `gate_decision_log` | `decision` | `'advance'` | `gate-evaluator.ts` (`recordGateDecision()`) |
| **Fallback** | `proposal_reviews` | `verdict` | `'approve'` | `submit_review` MCP action |

The primary path is used by the autonomous gate cubic. The fallback path allows a human operator or a review-style agent to approve without the full gate cubic flow.

---

## 5. Orchestrator bypass

The trigger would block the orchestrator's own transition writes if it executed the `UPDATE status` **after** inserting the `gate_decision_log` advance row in a separate statement. To allow the orchestrator to pre-insert the decision then immediately advance, use:

```sql
SET LOCAL app.gate_bypass = 'true';
```

`SET LOCAL` is transaction-scoped — it does not bleed to concurrent sessions. The `fn_apply_gate_advance` trigger installed by P611 (migration 059) uses this bypass when it fires atomically on `gate_decision_log` INSERT.

> **Never use `SET SESSION app.gate_bypass = 'true'`** — that disables enforcement for the entire connection lifetime.

---

## 6. Interaction with P611 auto-advance

P611 (migration `059-p611-gate-decision-auto-advance.sql`) adds a complementary `AFTER INSERT` trigger on `gate_decision_log` that automatically flips `proposal.status` when `decision='advance'` is inserted. The two triggers form a pair:

| Trigger | Table | Timing | Role |
|:--------|:------|:-------|:-----|
| `trg_guard_gate_advance` (P290) | `proposal` | BEFORE UPDATE | **Blocks** advancement without a decision |
| `trg_apply_gate_advance` (P611) | `gate_decision_log` | AFTER INSERT | **Drives** the advancement from the decision INSERT |

In the normal gate cubic flow:
1. Gate evaluator INSERTs `gate_decision_log` row with `decision='advance'`.
2. `trg_apply_gate_advance` fires, sets `app.gate_bypass='true'` (LOCAL), UPDATEs `proposal.status`.
3. `trg_guard_gate_advance` checks `app.gate_bypass` → passes.
4. Proposal is advanced. Both INSERTs are atomic — a crash between them is recovered by the orchestrator reconciler within 30 s.

---

## 7. The gate_decision_log schema

Defined in `database/ddl/018-gate-decision-audit.sql`, enhanced by migrations 023 and 066:

| Column | Type | Purpose |
|:-------|:-----|:--------|
| `id` | `int8` | Auto-identity PK |
| `proposal_id` | `int8` | FK → `roadmap.proposal` |
| `from_state` | `text` | Source status (e.g. `DRAFT`) |
| `to_state` | `text` | Target status (e.g. `REVIEW`) |
| `gate_level` | `text` | D1–D4 label |
| `decision` | `text` | `advance` / `hold` / `reject` / `waive` / `escalate` |
| `decided_by` | `text` | Agent identity |
| `ac_verification` | `jsonb` | `{passed, failed, checks[]}` |
| `dependency_check` | `jsonb` | `{resolved, blockers[]}` |
| `design_review` | `jsonb` | `{coherent, feedback[]}` |
| `rationale` | `text` | Human-readable explanation |
| `challenges` | `text[]` | Open questions raised by gatekeeper |
| `blockers` | `text[]` | Blocking issues (on reject/hold) |
| `project_id` | `uuid` | Tenant project FK (added migration 066) |
| `created_at` | `timestamptz` | Row insertion time |

**CHECK constraint:** `decision IN ('approve', 'reject', 'defer')` — original DDL. Migrations 023/059 extended the operational vocabulary to include `advance`, `hold`, `waive`, `escalate` via application-level enforcement (the trigger checks `decision='advance'` directly; the CHECK constraint does not enumerate all values post-migration).

---

## 8. Troubleshooting

### Transition rejected unexpectedly

```sql
-- Check for recent gate decisions on the proposal
SELECT id, from_state, to_state, decision, decided_by, created_at
FROM roadmap_proposal.gate_decision_log
WHERE proposal_id = <id>
ORDER BY created_at DESC
LIMIT 5;

-- Check for recent approvals in proposal_reviews
SELECT id, verdict, reviewed_at, reviewer_identity
FROM roadmap_proposal.proposal_reviews
WHERE proposal_id = <id>
  AND reviewed_at >= now() - INTERVAL '10 minutes';
```

If neither table has a qualifying entry within 10 minutes, the gate agent must run (or a manual `submit_review verdict=approve` must be issued) before the `UPDATE status` is retried.

### Manual operator override

To advance a proposal outside the gate flow (emergency only):

```sql
BEGIN;
SET LOCAL app.gate_bypass = 'true';
UPDATE roadmap_proposal.proposal
   SET status = 'REVIEW', modified_at = now()
 WHERE id = <id>;
-- Also insert a gate_decision_log row to preserve audit trail
INSERT INTO roadmap_proposal.gate_decision_log
  (proposal_id, from_state, to_state, gate_level, decision, decided_by, rationale)
VALUES (<id>, 'DRAFT', 'REVIEW', 'D1', 'advance', 'operator/<your-name>',
        'Manual operator advance — reason: <reason>');
COMMIT;
```

Always insert a `gate_decision_log` row even on bypass — this preserves the audit trail and prevents the P611 reconciler from treating the advance as stranded.

### Gate trigger is missing

```sql
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'roadmap_proposal.proposal'::regclass
  AND tgname = 'trg_guard_gate_advance';
```

If missing, re-apply migration 040:
```bash
psql -d hiveCentral -f scripts/migrations/040-p290-gate-enforcement.sql
```

---

## 9. Related proposals and files

| Reference | Purpose |
|:----------|:--------|
| P167 / `018-gate-decision-audit.sql` | Created `gate_decision_log` table |
| P290 / `040-p290-gate-enforcement.sql` | This enforcement trigger |
| P611 / `059-p611-gate-decision-auto-advance.sql` | Auto-advance from decision INSERT |
| P436 / `066-p436-control-plane-schema-reconcile.sql` | Added `project_id` to `gate_decision_log` |
| `src/apps/cubic-agents/gate-evaluator.ts` | Primary writer of `gate_decision_log` rows |
| `src/core/orchestration/legacy-dispatch.ts` | Orchestrator writes (hold/reject) + reconciler |
| `tests/integration/migration-059-gate-advance.test.ts` | Integration tests for trigger behavior |
| `docs/operations/p611-gate-advance-reconciler.md` | Companion guide for the auto-advance trigger |
