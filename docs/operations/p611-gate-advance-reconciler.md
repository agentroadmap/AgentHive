# Gate Advance Reconciler — Operator Guide (P611)

**Proposal:** P611 — Auto-advance reconciler: gate_decision_log advance verdict must flip proposal.status  
**Status:** COMPLETE  
**Migration:** `scripts/migrations/059-p611-gate-decision-auto-advance.sql`  
**Last revised:** 2026-04-27

---

## 1. What was built

Before P611, a gate cubic that crashed or skipped `prop_transition` after inserting a `gate_decision_log` row with `decision='advance'` left the proposal permanently stranded. The orchestrator's post-check had no compensating path for "advance is logged but status didn't flip."

**Root cause incident:** P472, gate_decision_log #158, `decision='advance'` at 2026-04-26 21:24:14Z. Proposal stayed `DRAFT/mature` until manual operator intervention.

P611 adds two complementary recovery paths:

| Path | Mechanism | Recovery latency |
|:---|:---|:---|
| **Trigger (primary)** | `trg_apply_gate_advance` fires atomically within the same INSERT transaction | 0 ms |
| **Reconciler (backstop)** | `reconcileStrandedAdvances()` in orchestrator.ts, every 30 s | ≤ 30 s |

After migration 059, `gate_decision_log.decision = 'advance'` is the durable source of truth. The trigger derives `proposal.status` from it atomically — the two-write atomicity gap is closed.

---

## 2. How the trigger works

`fn_apply_gate_advance()` is an `AFTER INSERT FOR EACH ROW` trigger on `roadmap_proposal.gate_decision_log`.

**Three-way status check (after locking proposal row FOR UPDATE):**

| `proposal.status` vs. logged states | Action |
|:---|:---|
| Equals `to_state` | No-op (agent already advanced — idempotent) |
| Equals `from_state` | UPDATE proposal, INSERT audit discussion row |
| Equals neither (drift) | INSERT warning discussion row only; do NOT advance |
| `decision != 'advance'` | RETURN NULL immediately (hold/reject/waive/escalate are silent) |

**Key invariants:**
- `SET LOCAL lock_timeout = '5s'` — gate INSERT fails hard after 5 s of lock contention rather than hanging silently. The reconciler closes the gap within 30 s.
- `SET LOCAL app.gate_bypass = 'true'` — required to bypass `fn_guard_gate_advance` (P290), which would otherwise reject the update because the decision row is not yet visible to other transactions. `SET LOCAL` is transaction-scoped; it does not bleed to concurrent sessions.
- SECURITY DEFINER + `SET search_path = roadmap_proposal, pg_temp` — prevents search-path injection.
- Audit row uses `author_identity='system/auto-advance'` and `context_prefix='gate-decision:'`.

**Atomicity guarantee:** If the trigger's UPDATE fails, the transaction rolls back both the `gate_decision_log` INSERT and the UPDATE together. State is clean for retry.

---

## 3. How the reconciler works

`reconcileStrandedAdvances(pool)` runs every 30 s in `scripts/orchestrator.ts`.

**Query — finds stranded advances in the last 24 h:**
```sql
SELECT gdl.id, gdl.proposal_id, gdl.from_state, gdl.to_state, gdl.decided_by
FROM roadmap_proposal.gate_decision_log gdl
JOIN roadmap_proposal.proposal p ON p.id = gdl.proposal_id
WHERE gdl.decision = 'advance'
  AND gdl.created_at > now() - INTERVAL '24 hours'
  AND UPPER(p.status) = UPPER(gdl.from_state)
ORDER BY gdl.created_at ASC;
```

**Per-row behavior:**
- Each row runs in an independent transaction with `try/catch`.
- A single row failure logs the error (with `gdl.id` and `proposal_id`) and continues — does not abort the reconciler run.
- UPDATE guard: `WHERE UPPER(status) = UPPER(from_state)` — races with the trigger produce 0 rows affected, not an error.
- Audit row uses `author_identity='system/reconciler'` (not `system/auto-advance`) so operators can distinguish trigger-applied advances from reconciler-applied advances in proposal history.

**Log lines to watch:**
```
Reconciler: Recovered N stranded advances
Reconciler: Failed to apply advance for proposal_id=X, gdl_id=Y: <msg>
```

---

## 4. Observability

### 4.1 Steady-state dashboard query

Returns 0 rows in a healthy system. Any row older than 2 minutes with status still at `from_state` means the trigger fired but failed and the reconciler hasn't run yet (or is broken).

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

### 4.2 Verify trigger exists

```sql
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE trigger_name = 'trg_apply_gate_advance';
-- Expected: 1 row, event_manipulation=INSERT, action_timing=AFTER
```

### 4.3 Verify reconciler is running

```bash
# Check orchestrator logs for reconciler heartbeat
grep "Reconciler:" /var/log/agenthive/orchestrator.log | tail -20
```

### 4.4 Audit trail — how an advance was applied

```sql
SELECT body, author_identity, created_at
FROM roadmap_proposal.proposal_discussions
WHERE proposal_id = <pid>
  AND context_prefix = 'gate-decision:'
ORDER BY created_at DESC LIMIT 5;
-- author_identity='system/auto-advance' → trigger applied
-- author_identity='system/reconciler'   → reconciler applied
```

---

## 5. Post-deploy checklist

Run after migration 059 is deployed:

- [ ] Trigger exists: run §4.2 query → 1 row returned
- [ ] Steady-state query returns 0 rows (§4.1)
- [ ] Orchestrator logs show `Reconciler: Recovered 0 stranded advances` (or N > 0 if backfill found stranded proposals)
- [ ] Run backfill report (§6) and decide on P497/gdl#144
- [ ] Verify CONVENTIONS.md §4 has the gate three-action rule bullet
- [ ] Verify CONVENTIONS.md §10a has the `#### Gate spawn author_identity convention` subsection

---

## 6. Backfill — surface historical stranded advances

Run once post-deploy to find proposals stranded before migration 059:

```sql
SELECT gdl.id   AS gdl_id,
       gdl.proposal_id,
       p.title,
       p.status AS current_status,
       gdl.from_state,
       gdl.to_state,
       gdl.decided_by,
       gdl.created_at
FROM roadmap_proposal.gate_decision_log gdl
JOIN roadmap_proposal.proposal p ON p.id = gdl.proposal_id
WHERE gdl.decision = 'advance'
  AND UPPER(p.status) = UPPER(gdl.from_state)
ORDER BY gdl.created_at DESC;
```

**Known stranded advance at time of P611 COMPLETE (2026-04-27):**

| proposal_id | gdl.id | Transition | decided_by | created_at |
|:---|:---|:---|:---|:---|
| P497 | 144 | DEVELOP → MERGE | code-reviewer-d3 | 2026-04-26 08:06:59Z |

Operator action required: decide whether to apply or close P497/gdl#144 as stale. Do not auto-apply without reviewing P497's current state.

To manually apply a stranded advance (after verifying P497 is still in DEVELOP):
```sql
BEGIN;
SET LOCAL app.gate_bypass = 'true';
SET LOCAL lock_timeout = '5s';
SELECT id, status FROM roadmap_proposal.proposal WHERE id = 497 FOR UPDATE;
-- Verify status = 'DEVELOP' before proceeding
UPDATE roadmap_proposal.proposal SET status = 'MERGE', maturity = 'new' WHERE id = 497;
INSERT INTO roadmap_proposal.proposal_discussions
    (proposal_id, author_identity, context_prefix, body)
VALUES (497, 'system/reconciler', 'gate-decision:',
    'Backfill: manual operator apply of gate_decision_log id=144 (DEVELOP→MERGE, decided_by: code-reviewer-d3). P611 post-deploy backfill.');
COMMIT;
```

---

## 7. Emergency controls

### 7.1 Disable trigger (leave reconciler active)

Suspends the atomic trigger without stopping the reconciler. Recovery latency degrades to ≤ 30 s.

```sql
ALTER TABLE roadmap_proposal.gate_decision_log
    DISABLE TRIGGER trg_apply_gate_advance;
```

Re-enable:
```sql
ALTER TABLE roadmap_proposal.gate_decision_log
    ENABLE TRIGGER trg_apply_gate_advance;
```

### 7.2 Full rollback (trigger + function)

Both commands are idempotent. They do NOT remove any `gate_decision_log` rows or reverse any `proposal.status` values already written.

```sql
DROP TRIGGER IF EXISTS trg_apply_gate_advance
    ON roadmap_proposal.gate_decision_log;
DROP FUNCTION IF EXISTS roadmap_proposal.fn_apply_gate_advance();
```

After full rollback, the reconciler continues to operate as the sole recovery path. Restart orchestrator to reload after rollback.

### 7.3 Disable reconciler only

Stop orchestrator, comment out the `reconcilerTimer = setInterval(...)` block, redeploy. The trigger remains active.

---

## 8. Integration test coverage

**Test file:** `src/test/migration-059-gate-advance.test.ts`  
Connects to a real DB — no mocks.

| Test | Scenario | Expected |
|:---|:---|:---|
| (a) advance path | INSERT decision=advance, proposal.status=from_state | status → to_state, maturity=new, 1 discussion row |
| (b) idempotent no-op | proposal.status already equals to_state | 0 rows updated, no error |
| (c) drift warning | status equals neither from_state nor to_state | 0 rows updated, 1 warning discussion row |
| (d) non-advance decision | INSERT decision=hold/reject/waive/escalate | trigger is silent no-op |

All four paths must pass before P611 PR is merged.

---

## 9. Out of scope

- Auto-rollback on reject — advance is monotonic; rollbacks require manual operator action.
- `orchestrator.ts:1330` (`dispatchImplicitGate`) and `:1548` (`_dispatchTransitionQueue`) — **NOT modified**. After migration 059, the trigger makes `reachedTarget` true by the time the orchestrator reads `proposal.status`. (AC-28 is definitive.)
- `gate_decision_log.decision` CHECK constraint — no change needed. Existing 5-value constraint (`advance`, `hold`, `reject`, `waive`, `escalate`) is correct. (AC-26 supersedes AC-18.)
- `pg_notify` for real-time reconciliation — deferred. Trigger's 0 ms atomicity makes ≤30 s reconciler latency acceptable as backstop.

---

## 10. Decision log for contradictory ACs

During development, several ACs contradicted each other. The authoritative resolution:

| Superseded | Superseding | Resolution |
|:---|:---|:---|
| AC-13 (migration=058) | **AC-19 / AC-23** | Migration is **059**; 058 reserved by P472 |
| AC-27 (no author_identity_template column) | **AC-31** | Column **exists** in live DB; AC-27 checked stale DDL |
| AC-25 (§10a doesn't exist) | **AC-32** | §10a exists in main at line 632; add bullet, don't create section |
| AC-18 (3-value constraint) | **AC-26** | CHECK has **5** values (waive + escalate also valid) |
| AC-36 (test dir = scripts/tests/) | **AC-39** | Test dir is **src/test/** |

When a later-numbered AC conflicts with an earlier one, the later AC wins.

---

## See also

- `scripts/migrations/059-p611-gate-decision-auto-advance.sql` — trigger + function DDL
- `src/test/migration-059-gate-advance.test.ts` — integration tests
- `CONVENTIONS.md §4` — gate agent three-action rule (prop_transition + set_maturity required)
- `CONVENTIONS.md §10a` — gate spawn author_identity convention
- P472 — incident that motivated P611 (gate_decision_log #158 stranded advance)
- P290 — `fn_guard_gate_advance` (the guard this trigger bypasses via `app.gate_bypass`)
