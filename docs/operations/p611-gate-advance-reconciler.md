# P611 — Gate-Advance Reconciler: Operator Guide

**Feature:** Auto-advance reconciler — `gate_decision_log.decision='advance'` must flip `proposal.status`
**Migration:** `scripts/migrations/059-p611-gate-decision-auto-advance.sql`
**Status:** COMPLETE
**Incident motivation:** P472 — gdl#158 wrote `decision='advance'` at 2026-04-26 21:24:14Z; proposal stayed `DRAFT/mature` until manual operator intervention.

---

## 1. What This Feature Does

Before this feature, advancing a proposal required two separate writes: a `gate_decision_log` INSERT and a `proposal.status` UPDATE. A crash, network failure, or bug between those two writes left the proposal permanently stranded — a logged `advance` verdict with no corresponding status change.

This feature makes `gate_decision_log.decision='advance'` the **durable source of truth**. Two cooperating mechanisms ensure every `advance` verdict eventually produces a matching status transition:

| Mechanism | When it fires | Recovery latency |
|:---|:---|:---|
| **Trigger `trg_apply_gate_advance`** (Option A, primary) | Atomically within the INSERT transaction | 0 ms |
| **Reconciler `reconcileStrandedAdvances`** (Option B, backstop) | Every 30 s via `orchestrator.ts` | ≤ 30 s |

The trigger eliminates the two-write atomicity problem for all future INSERTs. The reconciler covers three residual cases: historical rows stranded before migration 059 was deployed, rows stranded while the trigger was disabled, and rows stranded by a mid-deploy trigger replacement failure.

---

## 2. Trigger Mechanics (`trg_apply_gate_advance`)

### Function signature

```sql
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_apply_gate_advance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = roadmap_proposal, pg_temp
```

- **AFTER INSERT** on `roadmap_proposal.gate_decision_log`
- **FOR EACH ROW**
- **SECURITY DEFINER** — runs as function owner; `search_path` pinned to prevent injection

### Three-way status check

After acquiring a `SELECT ... FOR UPDATE` lock on the proposal row (with `SET LOCAL lock_timeout = '5s'`):

| Proposal `status` | Action |
|:---|:---|
| `= NEW.to_state` | **No-op** — already advanced; idempotent return |
| `= NEW.from_state` | **Advance** — `UPDATE proposal SET status=to_state, maturity='new'`; write audit discussion row (`author_identity='system/auto-advance'`) |
| anything else (drift) | **Warn only** — write warning discussion row; do NOT advance |

Non-advance decisions (`hold`, `reject`, `waive`, `escalate`) return immediately (`RETURN NULL`) — the trigger is silent for all five constraint values.

### Why `SET LOCAL app.gate_bypass = 'true'`

`fn_guard_gate_advance` (P290, migration 040) checks `current_setting('app.gate_bypass', true) = 'true'`. When the trigger fires, the newly inserted `gate_decision_log` row is not yet visible to other transactions and would not satisfy the guard's `SELECT`. Bypass is required. `SET LOCAL` is transaction-scoped — concurrent sessions are unaffected.

### Lock timeout

`SET LOCAL lock_timeout = '5s'` is the **first statement** in the trigger body, before the `FOR UPDATE`. If a competing long-running transaction holds the proposal row for more than 5 seconds, the gate INSERT fails with a hard error rather than blocking indefinitely. The reconciler backstop will recover the stranded advance within 30 s.

### Atomicity guarantee

```
INSERT into gate_decision_log   ─┐
  → trigger fires                │ one atomic transaction
  → proposal.status updated     ─┘
```

If the UPDATE fails, both the INSERT and the UPDATE roll back together. State is left clean for retry. `reachedTarget` in `dispatchImplicitGate` and `_dispatchTransitionQueue` will be `true` on the next orchestrator check — **no code changes are needed in those functions** (see §8).

---

## 3. Reconciler Behavior (`reconcileStrandedAdvances`)

Located in `scripts/orchestrator.ts`. Runs every 30 s via `reconcilerTimer`.

### Query

```sql
SELECT gdl.id, gdl.proposal_id, gdl.from_state, gdl.to_state, gdl.decided_by
FROM roadmap_proposal.gate_decision_log gdl
JOIN roadmap_proposal.proposal p ON p.id = gdl.proposal_id
WHERE gdl.decision = 'advance'
  AND gdl.created_at > now() - INTERVAL '24 hours'
  AND UPPER(p.status) = UPPER(gdl.from_state)
ORDER BY gdl.created_at ASC
```

The 24-hour window limits backfill scope. Rows older than 24 hours are intentionally excluded from automated recovery — use the one-time backfill report (§6) for those.

### Per-row isolation

Each stranded advance is applied in its own independent transaction with its own `try/catch`. A single row failure logs the error (including `gdl.id` and `proposal_id`) and continues to the next row — one bad row does not abort the reconciler run.

### Idempotency guard

The reconciler UPDATE uses `WHERE UPPER(status) = UPPER(from_state)` as a conditional guard. If the trigger already applied the advance between the reconciler's SELECT and UPDATE, the WHERE clause matches 0 rows — no error, no double-apply.

### Audit trail distinction

The reconciler writes its discussion row with `author_identity = 'system/reconciler'` (not `'system/auto-advance'`). This lets operators determine whether an advance was applied by the trigger or the reconciler when reviewing proposal history. The `context_prefix = 'gate-decision:'` and body format are otherwise identical.

### Log lines

```
Reconciler: Recovered N stranded advances
Reconciler: Failed to apply advance for proposal_id=X, gdl_id=Y: <error message>
```

### Shutdown safety

`reconcilerTimer` is cleared in `shutdown()` before `pool.end()`. No reconciler tick fires after SIGTERM is received.

### HA safety

Two orchestrator instances firing the reconciler simultaneously is safe: `SELECT FOR UPDATE` prevents concurrent apply; the conditional UPDATE guard ensures 0 rows affected on the second instance.

---

## 4. Observability Queries

### Steady-state dashboard (returns 0 rows in a healthy system)

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

Any row returned here is a stranded advance that has been waiting more than 2 minutes — the reconciler should have caught it. Investigate immediately.

### Trigger activity (recent auto-advances by trigger)

```sql
SELECT proposal_id, body, created_at
FROM roadmap_proposal.proposal_discussions
WHERE author_identity = 'system/auto-advance'
  AND context_prefix = 'gate-decision:'
ORDER BY created_at DESC
LIMIT 20;
```

### Reconciler activity (recent recoveries by backstop)

```sql
SELECT proposal_id, body, created_at
FROM roadmap_proposal.proposal_discussions
WHERE author_identity = 'system/reconciler'
  AND context_prefix = 'gate-decision:'
ORDER BY created_at DESC
LIMIT 20;
```

### Drift warnings (status mismatch at time of INSERT)

```sql
SELECT proposal_id, body, created_at
FROM roadmap_proposal.proposal_discussions
WHERE author_identity = 'system/auto-advance'
  AND context_prefix = 'gate-decision:'
  AND body LIKE 'WARNING:%'
ORDER BY created_at DESC;
```

---

## 5. Post-Deploy Checklist

Execute in this order after deploying migration 059:

- [ ] **Verify trigger exists:**
  ```sql
  SELECT tgname, tgenabled FROM pg_trigger
  WHERE tgname = 'trg_apply_gate_advance';
  ```
  Expected: 1 row, `tgenabled = 'O'` (enabled).

- [ ] **Verify function exists:**
  ```sql
  SELECT proname, prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'roadmap_proposal'
    AND p.proname = 'fn_apply_gate_advance';
  ```
  Expected: 1 row, `prosecdef = true`.

- [ ] **Run steady-state dashboard query** (§4) — should return 0 rows (or only P497/gdl#144 if not yet resolved).

- [ ] **Restart orchestrator** — activates `reconcilerTimer`.

- [ ] **Confirm reconciler log line** within 30 s of restart:
  ```
  Reconciler: Recovered N stranded advances
  ```
  `N = 0` is expected if P497/gdl#144 was resolved before restart; `N = 1` is expected if it was not.

- [ ] **Handle P497/gdl#144** (see §6).

- [ ] **Verify CONVENTIONS.md §4** has the gate three-action rule (see §10).

- [ ] **Verify CONVENTIONS.md §10a** has the `author_identity` convention bullet (see §10).

---

## 6. Backfill Procedure — P497/gdl#144

**Context (verified 2026-04-27):** Proposal P497 has a stranded `advance` in `gate_decision_log` row 144 (`DEVELOP → MERGE`, decided by `code-reviewer-d3`, created `2026-04-26 08:06:59Z`). This is the **only** stranded advance in the live DB as of deployment.

### Step 1 — Confirm current state

```sql
SELECT p.id, p.title, p.status, p.maturity,
       gdl.id AS gdl_id, gdl.from_state, gdl.to_state,
       gdl.decided_by, gdl.created_at
FROM roadmap_proposal.proposal p
JOIN roadmap_proposal.gate_decision_log gdl ON gdl.proposal_id = p.id
WHERE p.id = 497 AND gdl.id = 144;
```

### Step 2 — Operator decision

**Option A — Apply the advance (P497 progresses to MERGE):**

The reconciler will apply this automatically within 30 s of orchestrator restart (because gdl#144 is within the 24-hour window at time of first deployment). Verify with the steady-state dashboard query.

**Option B — Close as stale (P497 remains at DEVELOP):**

If the DEVELOP→MERGE advance is no longer valid (e.g. P497 has changed scope):
1. Manually `UPDATE roadmap_proposal.proposal SET status = 'MERGE'` then `UPDATE ... SET status = 'DEVELOP'` — this breaks the `UPPER(status) = UPPER(from_state)` guard without writing a spurious discussion row. OR:
2. Disable the trigger temporarily, insert a newer `gate_decision_log` row with `decision = 'hold'` for P497 to document the operator override, then re-enable.

### Step 3 — Full historical report (rows older than 24 hours)

After initial deployment, run the full backfill query to surface any rows outside the reconciler's 24-hour window:

```sql
SELECT gdl.id, gdl.proposal_id, p.title, p.status AS current_status,
       gdl.from_state, gdl.to_state, gdl.decided_by, gdl.created_at
FROM roadmap_proposal.gate_decision_log gdl
JOIN roadmap_proposal.proposal p ON p.id = gdl.proposal_id
WHERE gdl.decision = 'advance'
  AND UPPER(p.status) = UPPER(gdl.from_state)
ORDER BY gdl.created_at DESC;
```

P472/gdl#158 is NOT stranded — P472 is at `DEVELOP` status, past its `from_state = DRAFT`.

---

## 7. Emergency Controls

### Disable trigger (without removing it)

```sql
ALTER TABLE roadmap_proposal.gate_decision_log
  DISABLE TRIGGER trg_apply_gate_advance;
```

While disabled, the reconciler continues to heal stranded advances at ≤ 30 s latency. Re-enable with:

```sql
ALTER TABLE roadmap_proposal.gate_decision_log
  ENABLE TRIGGER trg_apply_gate_advance;
```

### Disable reconciler (without redeploying)

Set an environment variable or feature flag checked by the reconciler's setInterval callback, or restart the orchestrator with `RECONCILER_ENABLED=false` if that env-var is wired. The simplest production option is to disable the trigger (above) and note that the reconciler now serves as primary recovery.

### Full rollback (remove trigger + function)

```sql
DROP TRIGGER IF EXISTS trg_apply_gate_advance
  ON roadmap_proposal.gate_decision_log;

DROP FUNCTION IF EXISTS roadmap_proposal.fn_apply_gate_advance();
```

Both commands are **idempotent**. Neither removes `gate_decision_log` rows nor reverses any `proposal.status` values already written. Safe to run at any time, including during a partial rollback recovery.

After running these commands: the two-write gap is restored; gate cubic agents MUST call `prop_transition` themselves. The orchestrator reconciler code remains in `orchestrator.ts` but is harmless without the trigger — it will find no stranded rows if gate agents are correctly calling `prop_transition`.

---

## 8. Integration Test Matrix

Test file: `src/test/migration-059-gate-advance.test.ts`

All tests connect to a **real DB** — no mocks. All four paths must pass before merging P611.

| # | Test path | INSERT conditions | Expected outcome |
|:---|:---|:---|:---|
| (a) | **Advance path** | `decision='advance'`, `proposal.status = from_state` | `proposal.status` → `to_state`, `maturity` → `'new'`; 1 discussion row written (`author_identity='system/auto-advance'`) |
| (b) | **Idempotent no-op** | `decision='advance'`, `proposal.status` already `= to_state` | 0 rows updated; no error; no discussion row |
| (c) | **Drift warning** | `decision='advance'`, `proposal.status` ≠ `from_state` and ≠ `to_state` | 0 rows updated; 1 warning discussion row (`body LIKE 'WARNING:%'`) |
| (d) | **Non-advance decision** | `decision` ∈ `{hold, reject, waive, escalate}` | Trigger silent no-op; proposal unchanged; no discussion row |

### Reconciler tests (optional but recommended)

- Insert a `decision='advance'` row; disable trigger; confirm proposal not advanced after INSERT; enable reconciler poll; confirm proposal advances within 30 s.
- Verify `author_identity = 'system/reconciler'` in the discussion row written by the reconciler (not `'system/auto-advance'`).

---

## 9. AC Supersession Table

When ACs conflict, the **higher-numbered AC wins**. The table below resolves all known contradictions.

| Superseded | Superseding | Authoritative ruling |
|:---|:---|:---|
| AC-13 | **AC-19, AC-23** | Migration number is **059**, not 058. 058 is reserved by `058-p472-principal-identity.sql` on dev/codex-three. |
| AC-27 | **AC-31** | `gate_task_templates.author_identity_template` column **EXISTS** in the live DB (15 columns total, verified 2026-04-26 on codex-one). AC-27 checked a stale DDL backup. |
| AC-25 | **AC-32** | CONVENTIONS.md §10a **already exists** at line 519 in codex-one. Add a bullet — do not create a new section. |
| AC-18 | **AC-26** | `gate_decision_log.decision` CHECK has **5 values** (`advance, hold, reject, waive, escalate`). No constraint change needed. |
| AC-36 | **AC-39** | Integration test path is **`src/test/migration-059-gate-advance.test.ts`**. `scripts/tests/` does not exist. |
| AC-17 | **AC-31** (tie-breaks via AC-27→AC-31) | Both the DB column and CONVENTIONS.md §10a are valid canonical locations for the `author_identity` pattern. |

**AC-28 is definitive:** Do NOT modify `orchestrator.ts` lines for `dispatchImplicitGate` or `_dispatchTransitionQueue`. The trigger atomicity guarantee makes those edits unnecessary.

---

## 10. CONVENTIONS.md Changes Required

### Section 4 — Gate agent three-action rule

**Location (main repo):** After line 104 (the 7th bullet), before §4a at line 106.

Add as the 8th bullet:

> Gate cubic agents MUST call `prop_transition` (records `gate_decision_log` + flips status) and `set_maturity` after a verdict. The P611 reconciler is the safety net — omitting these is a protocol violation, not an acceptable shortcut.

Satisfies AC-11 and AC-16.

### Section 10a — Gate spawn `author_identity` convention

**Location (main repo):** §10a spans lines 632–720. Add a new subsection `#### Gate spawn author_identity convention` after line 714 (after the Source-of-truth rule section, before `#### What stops a gate run` at line 715).

Content:

> Gate cubic agents MUST use the following `author_identity` pattern when writing gate decisions:
> ```
> <provider>/<role>-d<level>-p<proposal_id>
> ```
> Example: `claude/skeptic-alpha-d1-p472`
>
> The canonical template is stored in `roadmap.gate_task_templates.author_identity_template`. CONVENTIONS.md §10a is the primary human-readable reference.

Satisfies AC-12 and AC-17.

**codex-four worktree:** §10a does NOT exist in codex-four as of 2026-04-27. It was added to main in commits `21c8518` + `ffe50c5` after codex-four branch point `4c4a87f`. Developer MUST rebase/merge main before editing CONVENTIONS.md.

---

## 11. Implementation Sequence

Execute in this order for zero-downtime deployment:

1. **Rebase/merge main** (if working in codex-four) — gets CONVENTIONS.md with §10a
2. **Deploy migration 059** — trigger becomes active immediately
3. **Update CONVENTIONS.md** §4 and §10a — independent of step 2
4. **Add `reconcileStrandedAdvances` function** in `orchestrator.ts` — merged but inactive until step 5
5. **Add `reconcilerTimer`** in `orchestrator.ts` startup block + `shutdown()` — activates on next restart
6. **Restart orchestrator** — reconciler starts polling
7. **Run post-deploy checklist** (§5)
8. **Handle P497/gdl#144** (§6)

Steps 2 and 3 are independent. Step 4 must precede step 5.

---

## 12. Out of Scope

The following were explicitly **not** implemented in P611:

- Auto-rollback on `reject` — advance is monotonic
- Cross-state arbitrary transitions
- `advance_with_conditions` verdict type — separate proposal if needed
- `fn_guard_gate_advance` modification — `app.gate_bypass` bypass is sufficient
- `gate_decision_log.decision` constraint change — existing 5-value constraint is correct
- Modifications to `orchestrator.ts:1330` (`dispatchImplicitGate`) or `:1548` (`_dispatchTransitionQueue`) — trigger atomicity eliminates the two-write gap (AC-28 is definitive)
- `pg_notify` for real-time reconciliation — deferred; trigger's 0 ms latency makes ≤ 30 s reconciler acceptable as backstop

---

## 13. Root Cause Reference (P472 Incident)

The P472 gate agent wrote `gate_decision_log` row #158 (`decision='advance'`) at 2026-04-26 21:24:14Z but did NOT call `prop_transition`. The proposal stayed `DRAFT/mature`.

The structural gap existed at two call sites in `orchestrator.ts`:

**`dispatchImplicitGate`** (codex-four: grep `dispatchImplicitGate`):
```ts
const reachedTarget =
    current && normalizeState(current.status) === normalizeState(gate.toStage);
if (result.exitCode === 0 && reachedTarget) { … return; }
// No recovery branch for: advance logged but status unchanged
```

**`_dispatchTransitionQueue`** (codex-four: grep `_dispatchTransitionQueue`):
```ts
const reachedTarget =
    current &&
    normalizeState(current.status) === normalizeState(transition.to_stage);
if (result.exitCode === 0 && reachedTarget) { … return; }
// Same gap
```

With migration 059 deployed, `reachedTarget` will be `true` after every successful gate INSERT — the trigger applies the status update atomically. These lines do not need to be changed.

P472 is no longer stranded: it reached `DEVELOP/mature` via manual operator intervention (gdl#158 is a `DRAFT→REVIEW` row; P472 is now past `DRAFT`). No backfill action required for P472.
