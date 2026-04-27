# P611 — Gate Advance Reconciler: Operator Guide

**Proposal:** P611  
**Migration:** `scripts/migrations/059-p611-gate-decision-auto-advance.sql`  
**Status:** COMPLETE  
**Last verified:** 2026-04-27

---

## Overview

P611 eliminates the two-write atomicity gap in the gate-loop advance path. Before this feature, a gate agent could write a `gate_decision_log` row with `decision='advance'` but then crash or skip the `prop_transition` call — leaving the proposal permanently stranded. P472 hit this exact failure mode (gdl#158, 2026-04-26).

The fix makes `gate_decision_log.decision = 'advance'` the durable source of truth via two complementary paths:

| Path | Mechanism | Latency | Handles |
|:---|:---|:---|:---|
| **Option A (primary)** | DB trigger `trg_apply_gate_advance` on `gate_decision_log` AFTER INSERT | 0 ms (atomic) | All future INSERTs |
| **Option B (backstop)** | Orchestrator `reconcileStrandedAdvances` timer (30s) | ≤ 30s | Historical rows, trigger disabled |

Both paths are idempotent and write an audit trail to `proposal_discussions`.

---

## Trigger Mechanics (Option A)

### Objects

| Object | Location |
|:---|:---|
| Function | `roadmap_proposal.fn_apply_gate_advance()` |
| Trigger | `trg_apply_gate_advance` on `roadmap_proposal.gate_decision_log` AFTER INSERT FOR EACH ROW |

### Logic (three-way status check)

```
INSERT into gate_decision_log (decision='advance')
  └─ fn_apply_gate_advance fires:
       1. decision != 'advance'?          → RETURN NULL (no-op)
       2. SET LOCAL lock_timeout = '5s'
       3. SELECT proposal FOR UPDATE
       4. proposal.status == to_state?    → RETURN NULL (idempotent no-op — agent already advanced)
       5. proposal.status != from_state?  → INSERT warning discussion row; RETURN NULL (drift)
       6. proposal.status == from_state:
            SET LOCAL app.gate_bypass='true'
            UPDATE proposal SET status=to_state, maturity='new'
            INSERT audit discussion row (author_identity='system/auto-advance')
```

### Why `SET LOCAL app.gate_bypass = 'true'`

`fn_guard_gate_advance` (P290, migration 040) checks `current_setting('app.gate_bypass', true) = 'true'`. When the trigger fires, the inserted row is **not yet visible** to other transactions and would not satisfy the guard's SELECT. The bypass is essential. `SET LOCAL` is transaction-scoped — concurrent sessions are never affected even though `fn_apply_gate_advance` is `SECURITY DEFINER`.

### Why `lock_timeout = '5s'`

Without a timeout, a competing long-running transaction holding the proposal row causes the gate_decision_log INSERT to block indefinitely, silently hanging the gate cubic. With the timeout, the INSERT fails with a hard error after 5s; the gate agent can retry, and the reconciler backstop closes any remaining stranded-advance window within 30s.

### Audit trail

Every trigger-applied advance writes one `proposal_discussions` row:
- `author_identity = 'system/auto-advance'`
- `context_prefix = 'gate-decision:'`
- `body = 'Auto-advanced <from>-><to> via gate_decision_log id=<id> (decided_by: <agent>). Trigger: fn_apply_gate_advance.'`

Drift warnings (status neither `from_state` nor `to_state`) write:
- `author_identity = 'system/auto-advance'`
- `body = 'WARNING: gate_decision_log id=<id> expects from=<X> but proposal.status=<Y> (to=<Z>). No action.'`

---

## Reconciler Behavior (Option B)

### Location in orchestrator.ts

```
let reconcilerTimer: NodeJS.Timeout | null = null;   // at module scope
                                                      // grep: "let implicitGateTimer"

reconcilerTimer = setInterval(                       // after IMPLICIT_GATE_POLL block
  () => reconcileStrandedAdvances(pool).catch(...),
  30_000
);

if (reconcilerTimer) clearInterval(reconcilerTimer); // in shutdown(), after implicitGateTimer clear
```

> **Note:** Line numbers differ between worktrees. Always grep for variable/function names — do not use hardcoded line numbers.

### What the reconciler does

Every 30 seconds:

1. Queries `gate_decision_log` for `decision='advance'` rows created in the last 24 hours where the proposal's current `status` still equals `from_state`.
2. For each stranded row: opens an independent transaction, SELECTs proposal FOR UPDATE, UPDATEs `status=to_state, maturity='new'` WHERE `UPPER(status)=UPPER(from_state)` (conditional guard for idempotency), inserts an audit discussion row.
3. Each row is wrapped in its own try/catch — one failure logs and continues, does not abort the full run.
4. Logs: `Reconciler: Recovered N stranded advances` or `Reconciler: Failed to apply advance for proposal_id=X, gdl_id=Y: <msg>`.

### Audit trail (reconciler vs. trigger distinction)

| Applied by | `author_identity` |
|:---|:---|
| Trigger (Option A) | `system/auto-advance` |
| Reconciler (Option B) | `system/reconciler` |

`context_prefix` and body format are otherwise identical. This distinction lets operators determine which path applied a given advance when reviewing `proposal_discussions`.

### HA safety

Two orchestrator instances both fire reconcilers. `SELECT FOR UPDATE` prevents concurrent apply. The conditional `UPDATE WHERE UPPER(status)=UPPER(from_state)` means the second instance always updates 0 rows — no error, clean idempotency.

---

## Observability Queries

### Steady-state health check (returns 0 rows in healthy system)

```sql
SELECT gdl.id, gdl.proposal_id, p.status AS current_status,
       gdl.from_state, gdl.to_state, gdl.decided_by,
       gdl.created_at, now() - gdl.created_at AS age
FROM roadmap_proposal.gate_decision_log gdl
JOIN roadmap_proposal.proposal p ON p.id = gdl.proposal_id
WHERE gdl.decision = 'advance'
  AND gdl.created_at > now() - INTERVAL '24 hours'
  AND UPPER(p.status) = UPPER(gdl.from_state)
  AND gdl.created_at < now() - INTERVAL '2 minutes'
ORDER BY gdl.created_at;
```

Any row here means either the trigger and reconciler both failed, or the system is in a partial deploy/rollback state. Investigate immediately.

### One-time backfill report (historical stranded advances)

```sql
SELECT gdl.id, gdl.proposal_id, p.title, p.status AS current_status,
       gdl.from_state, gdl.to_state, gdl.decided_by, gdl.created_at
FROM roadmap_proposal.gate_decision_log gdl
JOIN roadmap_proposal.proposal p ON p.id = gdl.proposal_id
WHERE gdl.decision = 'advance'
  AND UPPER(p.status) = UPPER(gdl.from_state)
ORDER BY gdl.created_at DESC;
```

### Verify trigger exists

```sql
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_schema = 'roadmap_proposal'
  AND event_object_table = 'gate_decision_log'
  AND trigger_name = 'trg_apply_gate_advance';
```

### Verify function exists

```sql
SELECT routine_name, security_type
FROM information_schema.routines
WHERE routine_schema = 'roadmap_proposal'
  AND routine_name = 'fn_apply_gate_advance';
```

---

## Post-Deploy Checklist

Run these steps after deploying migration 059 and restarting the orchestrator:

1. **Verify trigger installed:**
   ```sql
   -- Must return 1 row
   SELECT COUNT(*) FROM information_schema.triggers
   WHERE trigger_name = 'trg_apply_gate_advance';
   ```

2. **Verify function installed:**
   ```sql
   SELECT routine_name FROM information_schema.routines
   WHERE routine_schema = 'roadmap_proposal'
     AND routine_name = 'fn_apply_gate_advance';
   ```

3. **Run steady-state health check** — expect 0 rows (trigger + reconciler should have resolved any pre-existing stranded advances within 30s of orchestrator restart).

4. **Run backfill report** — identify any historical stranded advances predating migration 059.

5. **Handle P497/gdl#144** — see Backfill Procedure below.

6. **Verify reconciler timer** in orchestrator logs — look for `Reconciler: Recovered` or absence of `Reconciler:` lines (silence is OK if no stranded advances exist).

7. **Verify shutdown clean** — send SIGTERM, confirm no `Reconciler:` log lines appear after the shutdown message.

---

## Backfill Procedure (P497 / gdl#144)

**Live DB status (verified 2026-04-27):**
- `proposal_id=497`, `gdl.id=144`, `decision=advance`, `from_state=DEVELOP`, `to_state=MERGE`
- `decided_by=code-reviewer-d3`, `created_at=2026-04-26 08:06:59Z`
- **P472 is NOT stranded** — gdl#158 was DRAFT→REVIEW; P472 is now at DEVELOP (past from_state).

**Post-migration-059 operator decision required for P497/gdl#144:**

Option A — Apply the advance (P497 should proceed to MERGE):
```sql
-- Trigger will handle this automatically once migration 059 is deployed.
-- If trigger does not fire for historical rows, apply manually:
BEGIN;
SET LOCAL app.gate_bypass = 'true';
UPDATE roadmap_proposal.proposal
SET status = 'MERGE', maturity = 'new'
WHERE id = 497 AND UPPER(status) = UPPER('DEVELOP');
INSERT INTO roadmap_proposal.proposal_discussions
  (proposal_id, author_identity, context_prefix, body)
VALUES (497, 'system/operator-backfill', 'gate-decision:',
  'Manual backfill: applied advance from gate_decision_log id=144 (DEVELOP->MERGE, decided_by: code-reviewer-d3, created_at: 2026-04-26 08:06:59Z). P611 post-deploy operator action.');
COMMIT;
```

Option B — Close as stale (P497 advance is no longer valid):
```sql
INSERT INTO roadmap_proposal.proposal_discussions
  (proposal_id, author_identity, context_prefix, body)
VALUES (497, 'system/operator-backfill', 'gate-decision:',
  'Operator decision: gate_decision_log id=144 advance (DEVELOP->MERGE) closed as stale. Reason: [operator notes here]. P611 post-deploy review.');
```

> **Note:** The reconciler's 24-hour window means gdl#144 (created 2026-04-26) will **not** be auto-applied by the reconciler after migration 059 deploys (age > 24h). Operator must decide and act manually.

---

## Emergency Controls

### Disable trigger (keep function, stop auto-advance)

```sql
ALTER TABLE roadmap_proposal.gate_decision_log
  DISABLE TRIGGER trg_apply_gate_advance;
```

This is the fastest rollback if the trigger causes issues. The reconciler continues to operate at ≤30s latency as the backstop.

### Re-enable trigger

```sql
ALTER TABLE roadmap_proposal.gate_decision_log
  ENABLE TRIGGER trg_apply_gate_advance;
```

### Full removal (trigger + function)

```sql
DROP TRIGGER IF EXISTS trg_apply_gate_advance
  ON roadmap_proposal.gate_decision_log;
DROP FUNCTION IF EXISTS roadmap_proposal.fn_apply_gate_advance();
```

Both commands are idempotent. Neither removes `gate_decision_log` rows nor reverses any `proposal.status` values already written.

### Disable reconciler (orchestrator restart required)

Set `IMPLICIT_GATE_RECONCILER_DISABLED=true` in the orchestrator environment and restart. (If no env var gate exists, comment out the `reconcilerTimer` setInterval block and redeploy.)

---

## Integration Test Matrix

**Test file:** `src/test/migration-059-gate-advance.test.ts`

Tests connect to a real DB. No mocks.

| # | Scenario | INSERT decision | Proposal status before | Expected outcome |
|:---|:---|:---|:---|:---|
| a | **Advance path** | `advance` | `from_state` | `proposal.status` flips to `to_state`, `maturity='new'`, one `proposal_discussions` row written (`author_identity='system/auto-advance'`) |
| b | **Idempotent no-op** | `advance` | already `to_state` | 0 proposal rows updated, no error, no discussion row written |
| c | **Drift warning** | `advance` | neither `from_state` nor `to_state` | 0 proposal rows updated, one warning discussion row written |
| d | **Non-advance decision no-op** | `hold` / `reject` / `waive` / `escalate` | `from_state` | trigger is silent no-op; proposal unchanged |

All four paths must pass before P611 PR is merged.

---

## AC Supersession Table

When ACs conflict, the higher-numbered AC is authoritative.

| Superseded | Superseding | Topic |
|:---|:---|:---|
| AC-13 | **AC-19 / AC-23** | Migration number is **059**, not 058 |
| AC-27 | **AC-31** | `gate_task_templates.author_identity_template` column **EXISTS** in live DB |
| AC-25 | **AC-32** | CONVENTIONS.md §10a **already exists** (codex-one line 519); ADD bullet, do not create section |
| AC-18 | **AC-26** | `decision` CHECK has **5** values (`advance`, `hold`, `reject`, `waive`, `escalate`); no constraint change needed |
| AC-36 | **AC-39** | Integration test path is `src/test/migration-059-gate-advance.test.ts` (not `scripts/tests/`) |

**AC-28 is definitive:** do NOT modify `orchestrator.ts` lines for `dispatchImplicitGate` or `_dispatchTransitionQueue`. The trigger's atomicity makes those changes unnecessary.

---

## CONVENTIONS.md Changes Required

### Section 4 — Gate agent three-action rule (AC-44)

Insertion point: after the 7th bullet (line 104 in main), before §4a (line 106).

Add as 8th bullet:
> Gate cubic agents MUST call `prop_transition` (records `gate_decision_log` + flips status) and `set_maturity` after a verdict. The P611 reconciler is the safety net — omitting these is a protocol violation, not an acceptable shortcut.

### Section 10a — Gate spawn author_identity convention (AC-43)

Insertion point in main repo: after line 714 (Source-of-truth rule section), before `#### What stops a gate run` (line 715).

Add new subsection:
```
#### Gate spawn author_identity convention

Gate spawn `author_identity` follows the pattern: `<provider>/<role>-d<level>-p<proposal_id>`

Examples:
- `claude/skeptic-alpha-d1-p472`
- `claude/architecture-reviewer-d2-p611`

Canonical template stored in `roadmap.gate_task_templates.author_identity_template`.
```

> **codex-four worktree gap:** §10a does NOT exist in codex-four as of 2026-04-27. Developer must rebase/merge main (commits `21c8518` + `ffe50c5`) before editing CONVENTIONS.md.

---

## Architecture Notes

### Why not pg_notify?

A `pg_notify` listener would achieve near-zero latency without polling. Rejected for this iteration:
- Orchestrator startup already has three timers — a fourth listener adds restart-order complexity.
- `LISTEN/NOTIFY` does not replay on reconnect, so a missed notification during restart leaves the same stranded-advance window the trigger already closes.
- The trigger's atomic guarantee makes ≤30s reconciler latency acceptable as a backstop.

Revisit if the reconciler adds observable overhead at scale.

### Atomicity invariant

With `trg_apply_gate_advance` deployed, the two-write atomicity problem is **eliminated for all future INSERTs**:
- INSERT commits → trigger fires → `proposal.status` updated → all in one atomic commit.
- INSERT rolls back → trigger does not fire → no state change → clean retry possible.

This means `dispatchImplicitGate` and `_dispatchTransitionQueue` require **no code changes** — `reachedTarget` will be `true` whenever the gate agent successfully commits its decision row.

### Reconciler scope post-migration 059

The reconciler handles three residual cases:
1. **Backfill:** proposals stranded before migration 059 was deployed.
2. **Trigger disabled:** operator ran `ALTER TABLE ... DISABLE TRIGGER`.
3. **Function replacement failure:** broken `fn_apply_gate_advance` mid-deploy.

---

## See Also

- [P611 Proposal Design](../../proposals/P611-gate-advance-reconciler.md) — full design, drawbacks, AC list
- [CONVENTIONS.md](../../CONVENTIONS.md) — gate agent protocol (§4, §10a)
- [Migration 059](../../scripts/migrations/059-p611-gate-decision-auto-advance.sql) — SQL source
- [Integration tests](../../src/test/migration-059-gate-advance.test.ts) — four test paths
