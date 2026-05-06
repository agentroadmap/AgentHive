# P239 — Transition Queue Completion Guard

**Type:** Issue fix  
**Status:** COMPLETE  
**Related:** P206 (gate evaluator), P223 (orchestrator), P237 (proposal OS), P238 (state machine dashboard)

---

## Problem

The gate pipeline was producing a false-positive completion signal. When a D1–D4 gate job ran, it marked the `transition_queue` row `status = 'done'` even when the underlying proposal never advanced to the target workflow stage. The result:

- Proposals such as P195 stayed at `DRAFT/mature` indefinitely.
- Operators saw D1 queue rows in `done` state and assumed the gate had run successfully.
- Subsequent scans suppressed re-enqueueing because an existing `done` row blocked the `NOT EXISTS` guard in `fn_enqueue_mature_proposals()`.
- Actual proposal state never changed — the state machine appeared to run but did nothing observable.

The root confusion was a semantic one: `transition_queue.status` was being used as both worker bookkeeping *and* as a proxy for proposal state. Once "done" had two meanings, neither was reliable.

---

## Fix

### 1. DB Trigger: `fn_guard_transition_queue_done` (migration 029)

A `BEFORE UPDATE` trigger on `roadmap.transition_queue` enforces the semantic boundary at the DB layer:

```sql
-- A row can only become 'done' if the proposal status already equals to_stage.
IF NEW.status = 'done' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT p.status INTO v_current_status FROM roadmap_proposal.proposal ...
    IF LOWER(v_current_status) <> LOWER(NEW.to_stage) THEN
        RAISE EXCEPTION '...'
            USING HINT = 'Queue completion is worker bookkeeping only; apply the proposal state transition first.';
    END IF;
END IF;
```

**File:** `scripts/migrations/029-transition-queue-completion-guard.sql`

This makes it structurally impossible for any code path — current or future — to record queue completion before the proposal state has changed.

### 2. Historical Data Cleanup (migration 029)

The same migration retroactively resets all existing false-positive `done` rows to `failed`:

```sql
UPDATE roadmap.transition_queue tq
SET status = 'failed',
    last_error = 'false completion cleanup: queue was marked done but proposal state still equals from_stage',
    metadata = ... || jsonb_build_object('false_completion_cleanup_at', now(), 'previous_status', 'done')
FROM roadmap_proposal.proposal p
WHERE p.id = tq.proposal_id
  AND tq.status = 'done'
  AND LOWER(p.status) = LOWER(tq.from_stage)   -- proposal never moved
  AND LOWER(p.status) <> LOWER(tq.to_stage);
```

This unblocks any mature proposal whose retry was suppressed by a stale `done` row. On the next scan, `fn_enqueue_mature_proposals()` sees no active or recent `done` row and creates a fresh `pending` entry.

### 3. Application-Layer Guard: `completeTransitionIfApplied` (pipeline-cron.ts)

The spawn-agent dispatch path in `PipelineCron` now uses a conditional UPDATE rather than an unconditional one:

```typescript
// Only marks done if the proposal already reached to_stage.
UPDATE roadmap.transition_queue tq
SET status = 'done', completed_at = now(), last_error = NULL
WHERE tq.id = $1
  AND EXISTS (
    SELECT 1 FROM roadmap_proposal.proposal p
    WHERE p.id = tq.proposal_id
      AND LOWER(p.status) = LOWER(tq.to_stage)
  )
```

If the UPDATE matches zero rows (proposal didn't transition), the row is passed to `handleTransitionFailure()` with the message `"transition target not applied: proposal did not reach <stage>"`. This triggers exponential-backoff retry (up to `max_attempts`), and on exhaustion, fires a `CRITICAL` notification to the ops channel.

**File:** `src/core/pipeline/pipeline-cron.ts:1283–1306`

### 4. MCP Cubic Dispatch Path

When dispatching via MCP cubic tools (`cubic_create` + `cubic_focus`), the row is set to `processing` only — not `done`. The agent works asynchronously; the queue row stays in `processing` until the proposal state change is observed externally. The trigger enforces this at write time regardless of which code path touches the row.

**Key invariant confirmed by test** (`tests/unit/pipeline-cron.test.ts:218–226`):

```
// The queue stays processing until the proposal status itself reaches the target stage.
assert.ok(sqlCalls.some(call => call.text.includes("SET status = 'processing'")));
assert.equal(sqlCalls.some(call => call.text.includes("SET status = 'done'")), false);
```

### 5. Enqueue Notification Fix (migration 030)

A follow-on fix corrected `fn_enqueue_mature_proposals()`, which had drifted from migration 020 and was no longer emitting `pg_notify('transition_queued', ...)`. Without the notification, newly-enqueued D1 rows were visible in the queue but invisible to the orchestrator's event loop.

The function was updated to capture the `RETURNING id` from the INSERT and emit the notification with the queue row ID:

```sql
IF v_queue_id IS NOT NULL THEN
    PERFORM pg_notify('transition_queued', jsonb_build_object(
        'source', 'fn_enqueue_mature_proposals',
        'queue_id', v_queue_id,
        ...
    )::text);
END IF;
```

**File:** `scripts/migrations/030-enqueue-transition-notify-queue-id.sql`

---

## Semantic Clarification

> `transition_queue.status` is **worker bookkeeping**, not proposal state.

| Status | Meaning |
|--------|---------|
| `pending` | Work has been enqueued, waiting to be claimed by a worker |
| `processing` | A worker has claimed the row and dispatched an agent or cubic |
| `done` | Worker bookkeeping complete **and** proposal.status = to_stage (enforced by trigger) |
| `failed` | Dispatch failed, or proposal did not transition after agent ran; eligible for retry |

The canonical source of proposal state is `roadmap_proposal.proposal.status` and the `proposal_state_transitions` audit log. Never infer proposal state from `transition_queue.status`.

---

## Observability

When a gate pipeline false-positive occurs after this fix, operators will see:

1. **Queue row** in `failed` state with `last_error = "transition target not applied: proposal did not reach <stage>"`
2. **Notification** in `roadmap.notification_queue` at `severity = CRITICAL`, channel `ops`, once `max_attempts` is exhausted
3. **Trigger exception** in Postgres logs if any code path tries to bypass the application guard: `Cannot complete transition_queue %: proposal % is in state %, expected %`

---

## Files Changed

| File | Change |
|------|--------|
| `scripts/migrations/029-transition-queue-completion-guard.sql` | DB trigger + historical data cleanup |
| `scripts/migrations/030-enqueue-transition-notify-queue-id.sql` | Fix `fn_enqueue_mature_proposals` to emit queue_id in notify |
| `src/core/pipeline/pipeline-cron.ts` | `completeTransitionIfApplied()` conditional UPDATE; dispatch path keeps rows in `processing` not `done` |
