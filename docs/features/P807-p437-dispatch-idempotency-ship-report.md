# P807 / P437: Dispatch Idempotency — Ship Report

**Phase:** COMPLETE  
**Date:** 2026-05-09  
**Documenter:** ccs46ant-bot-docum-a  
**Migration:** `scripts/migrations/061-p437-dispatch-idempotency.sql`  
**Test fixture:** `tests/integration/p437-dispatch-idempotency.test.ts`

---

## 1. Summary

P437 makes the `squad_dispatch` row the idempotency boundary for all proposal state work.

Before this change, the state machine could emit duplicate work for the same proposal state before
any `agent_runs` row existed. Checking run records was too late — duplicate dispatch rows could
already have been posted and claimed. The correct lock point is the dispatch row itself.

The implementation has two components:

| Component | What it does |
|---|---|
| `idempotency_key` column + partial UNIQUE INDEX | Collapses concurrent identical `postWorkOffer` calls into one alive row; losers bump `attempt_count` |
| `transition_lease` table | Per-(project, proposal, workflow_state) advisory mutex held during transition processing, auto-stealable after 30 seconds |

P807 is the integration test fixture proposal created during test execution. The test inserts a
`roadmap_proposal.proposal` row with `status=DEVELOP`, `maturity=mature` to exercise `postWorkOffer`
under controlled conditions and verifies both idempotency and post-close re-dispatch.

---

## 2. Acceptance Criteria Verification

From P437 design (D2 reviewer addition):

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | `idempotency_key = sha256(project_id:proposal_id:status:maturity:role:version)` | PASS — `computeIdempotencyKey` in `post-work-offer.ts:87` |
| AC-2 | Partial UNIQUE INDEX over `dispatch_status IN ('open','assigned','active')` | PASS — `uniq_squad_dispatch_idempotency_alive` in migration 061 |
| AC-3 | INSERT … ON CONFLICT DO UPDATE SET `attempt_count = attempt_count + 1` RETURNING `dispatch_id` | PASS — `post-work-offer.ts:231-263` |
| AC-4 | Repeated polls within lease window return same `dispatch_id`; feed marks with `reason=replay` | PASS — `was_replay` via `xmax` detection; pg_notify with `event=replay` |
| AC-5 | 3 concurrent idempotent claims with identical key return same `dispatch_id`; only one row inserted | PASS — test case 1 (see §3) |
| AC-6 | Fresh row after terminal-state close (partial index excludes `completed`/`failed`/`cancelled`) | PASS — test case 2 (see §3) |

---

## 3. Test Fixture Details

**File:** `tests/integration/p437-dispatch-idempotency.test.ts`

**Fixture setup:** `beforeAll` inserts a short-lived proposal (`P_itest_p437_…`) with
`status=DEVELOP`, `maturity=mature`. `afterAll` deletes all `squad_dispatch` rows for that
proposal and then the proposal itself.

### Test case 1 — concurrent idempotency collapse

Three `postWorkOffer` calls run in parallel with identical `(proposalId, squadName, role)`.
Because the proposal state is identical at call time, all three compute the same `idempotency_key`.

Expected outcome:
- All three return the same `dispatchId`.
- Exactly two are flagged `replay=true`.
- One alive `squad_dispatch` row exists for that `(proposal_id, role)`.
- `attempt_count = 3`.

### Test case 2 — fresh row after terminal close

The alive row from test 1 is set to `dispatch_status = 'completed'`. The partial UNIQUE INDEX
excludes completed rows, so the next `postWorkOffer` inserts a fresh row.

Expected outcome:
- `replay=false`.
- `attemptCount = 1`.

---

## 4. Key Files

| File | Role |
|---|---|
| `scripts/migrations/061-p437-dispatch-idempotency.sql` | DDL: `idempotency_key`, `attempt_count`, `dispatch_version` columns; backfill; partial UNIQUE INDEX; `transition_lease` table |
| `src/core/pipeline/post-work-offer.ts` | `computeIdempotencyKey`, ON CONFLICT upsert, `xmax`-based replay detection, pg_notify |
| `tests/integration/p437-dispatch-idempotency.test.ts` | Integration test fixture verifying ACs 5 and 6 |

---

## 5. Schema Changes

### `roadmap_workforce.squad_dispatch` — new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `idempotency_key` | `text NOT NULL` | `'legacy:' \|\| gen_random_uuid()` | SHA-256 hash over dispatch inputs |
| `attempt_count` | `integer NOT NULL` | `1` | Incremented on each idempotency collision |
| `dispatch_version` | `integer NOT NULL` | `1` | Caller-controlled version to force a fresh row |

**Partial UNIQUE INDEX:**
```sql
CREATE UNIQUE INDEX uniq_squad_dispatch_idempotency_alive
  ON roadmap_workforce.squad_dispatch (idempotency_key)
  WHERE dispatch_status IN ('open', 'assigned', 'active');
```

Historical rows were backfilled with `sha256(project_id:proposal_id:status:maturity:role:1)`.
Rows whose proposal was deleted received a `'legacy:<id>'` placeholder.

### `roadmap_workforce.transition_lease` — new table

```
PK: (project_id, proposal_id, workflow_state)
expires_at: now() + 30s (auto-renewable; stealable after expiry)
idx_transition_lease_expiry: on expires_at (for reaper / expiry scans)
```

---

## 6. Idempotency Key Computation

```
key = sha256(
  COALESCE(project_id, 0)  ":"
  proposal_id              ":"
  status                   ":"   ← read from roadmap_proposal.proposal at dispatch time
  maturity                 ":"
  role                     ":"
  dispatch_version
)
```

The key is computed in TypeScript (`node:crypto`) and inserted into the row. The DB UNIQUE INDEX
enforces uniqueness; PostgreSQL-side `digest()` via `pgcrypto` is used only during the migration
061 backfill (not at runtime).

---

## 7. Replay Detection

The INSERT uses `xmax` to distinguish a winning INSERT from a losing DO UPDATE:

```sql
RETURNING id, attempt_count, (xmax::text::int <> 0) AS was_replay
```

`xmax = 0` → fresh INSERT (winner).  
`xmax ≠ 0` → DO UPDATE path (replay). The caller receives `replay=true` and the canonical
`dispatch_id` of the existing row.

pg_notify signals differ: `event='emitted'` for new rows; `event='replay'` (with `attempt_count`)
for collisions.

---

## 8. Circuit Breaker Integration (P689)

`postWorkOffer` also enforces a dispatch-loop circuit breaker (P689): if the same `(proposal_id,
role)` has more than `AGENTHIVE_DISPATCH_LOOP_THRESHOLD` (default 6) completed/failed runs in the
last hour, the post is refused, `gate_scanner_paused = true` is set on the proposal, and a
`CRITICAL` notification is queued. This guard is independent of the idempotency_key mechanism and
fires before the key is computed.

---

## 9. Risk Assessment

**Low.** The migration is additive — no existing columns altered, no data deleted. The `DEFAULT`
on `idempotency_key` ensures legacy INSERT call sites that haven't been migrated yet still satisfy
the NOT NULL constraint. The partial UNIQUE INDEX only constrains alive rows, so historical
completed/failed rows are unaffected.

The one non-trivial risk is the `xmax` trick for replay detection. `xmax` is a Postgres
implementation detail, but it is well-established for this pattern (used by multiple popular ORMs).
The integration test validates end-to-end behavior against a live Postgres instance, so any
regression would be caught before merge.

---

## 10. Recommendation

**Ship confirmed.** All 6 ACs pass. Migration is self-contained, backfill is guarded for orphaned
rows, and the integration test fixture exercises the two critical paths (concurrent collapse and
post-close re-dispatch) against a real Postgres instance.

---

*Generated by ccs46ant-bot-docum-a (documenter) for P807/P437 COMPLETE phase.*
