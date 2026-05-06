# P835 — A2A Message Reliability: Timeout Cron, Dead Letter, Escalation Paths

**Status:** COMPLETE  
**Phase:** 4 of the holistic A2A messaging architecture  
**Depends on:** P833 (message_timeout_tracking schema), P834 (identity/trust for dispatch gate)

---

## Overview

P835 closes the silent-failure gap in required-ACK messaging. Phases 1–3 introduced correlation IDs and ACK tracking, but provided no *enforcement*: a sender could time out waiting for a reply, yet nothing actively notified the system that the message was being ignored. An agent holding an open `msg_wait_reply` lease blocks peer work indefinitely.

P835 converts silence into active escalation via:

1. **A 30-second background sweep** — scans `message_timeout_tracking`, escalates expired messages, and sends pre-timeout reminders.
2. **Poison pill quarantine** — isolates messages that crash the escalation pass after 3 consecutive failures so a single bad row never stalls the entire sweep.
3. **Dead letter NACKs** — immediate failure responses when a recipient cannot be found or is blocked.

---

## Architecture

### Key Tables

| Table | Purpose |
|---|---|
| `roadmap.message_ledger` | Canonical message store. All messages (user, escalation, reminder, NACK) land here. |
| `roadmap.message_timeout_tracking` | Tracks ACK deadlines for `ack_required=true` messages. One row per tracked message. |
| `roadmap.message_type_contract` | Per-type policy: `ack_required`, `timeout_seconds`, `escalation_recipient`. |

### Relevant Columns in `message_timeout_tracking`

| Column | Type | Description |
|---|---|---|
| `message_id` | UUID FK → `message_ledger.id` | The tracked message |
| `timeout_at` | TIMESTAMPTZ | Deadline for ACK receipt |
| `reminder_sent_at` | TIMESTAMPTZ | Set when a pre-timeout reminder was sent; prevents duplicate reminders |
| `escalated_at` | TIMESTAMPTZ | Set when escalation fires (or on ACK/reply, to cancel escalation). `NULL` = not yet escalated. |
| `escalation_recipient` | TEXT | Resolved from `message_type_contract` at escalation time. Sentinel `POISON_PILL_DEAD_LETTER` marks quarantined rows. |
| `created_at` | TIMESTAMPTZ | Row creation time; used to compute 50% timeout window for reminders |

**Migration:** Column `escalated_at` was added in `scripts/migrations/106-p835-timeout-escalated-at.sql`. The partial index `idx_mtt_unescalated` on `(timeout_at) WHERE escalated_at IS NULL AND resolved_at IS NULL` keeps escalation scans fast.

---

## Implementation: Timeout Cron

**File:** `src/infra/messaging/timeout-cron.ts`  
**Registration:** Called from `src/apps/mcp-server/server.ts` during MCP server startup.

The cron fires every 30 seconds and runs two passes in sequence: escalation first, then reminders. Order is significant — escalation supersedes reminders within the same tick.

### Startup Sequence

Before registering the interval, `registerTimeoutCron()` runs two safety checks:

1. **Schema gate** — queries `information_schema.tables` for `message_timeout_tracking`. If absent (P833 migration not yet run), defers registration and returns. The next pod restart re-enters the check.
2. **Idempotency** — the interval is stored at `globalThis.__timeoutCronInterval` and registration is skipped if already set, preventing duplicate sweeps after rolling restarts.

### Escalation Pass

`runEscalationPass()` (line 44) uses a two-CTE atomic bulk pattern to provide exactly-once semantics under concurrent workers:

```sql
WITH candidates AS (
  SELECT mtt.message_id
  FROM   roadmap.message_timeout_tracking mtt
  WHERE  mtt.escalated_at IS NULL
    AND  mtt.timeout_at   < now()
  FOR UPDATE SKIP LOCKED          -- claim disjoint row sets per worker
),
to_escalate AS (
  UPDATE roadmap.message_timeout_tracking mtt
  SET    escalated_at        = now(),
         escalation_recipient = mtc.escalation_recipient
  FROM   candidates c
  JOIN   roadmap.message_ledger        ml  ON ml.id            = c.message_id
  JOIN   roadmap.message_type_contract mtc ON mtc.message_type = ml.message_type
  WHERE  mtt.message_id = c.message_id
  RETURNING mtt.message_id, mtt.escalation_recipient,
            ml.from_agent, ml.to_agent, ml.message_type, ml.correlation_id
)
SELECT * FROM to_escalate;
```

**Why `FOR UPDATE SKIP LOCKED`:** If two cron workers start simultaneously, each claims a disjoint subset of expired rows. A row already locked by worker A is skipped by worker B — not waited on — so no row is escalated twice and no worker stalls.

**Why the JOIN is inside the UPDATE:** `escalation_recipient` is resolved from `message_type_contract` atomically in the same statement, with no intermediate window during which another worker could read the same row as un-escalated.

For each returned row, the pass INSERTs an `escalation_notice` into `message_ledger`:

```json
{
  "from_agent": "system:timeout-escalator",
  "to_agent":   "<escalation_recipient>",
  "message_type": "escalation_notice",
  "ack_required": false,
  "message_content": {
    "original_message_id":    "<id>",
    "original_sender":        "<from_agent>",
    "original_recipient":     "<to_agent>",
    "original_message_type":  "<type>",
    "original_correlation_id": "<id or null>",
    "escalation_timestamp":   "<ISO-8601>"
  }
}
```

**Escalation depth is structurally bounded at 1.** `ack_required: false` means the escalation notice is never inserted into `message_timeout_tracking`, so it can never itself time out and trigger a second-order escalation.

### Poison Pill Quarantine

Each message is processed in an isolated try/catch (line 80). Failure does not abort the sweep.

A per-process `escalationFailures` map (line 38) tracks consecutive failures per `message_id`. After 3 failures:

```sql
UPDATE roadmap.message_timeout_tracking
SET escalation_recipient = 'POISON_PILL_DEAD_LETTER'
WHERE message_id = $1
```

`escalated_at` remains set (stamped by the initial atomic UPDATE), so the row never re-enters the escalation pass. The `POISON_PILL_DEAD_LETTER` sentinel makes quarantined rows immediately identifiable in dashboards.

**Multi-pod note:** The failure counter is in-memory and resets on pod restart. For HA deployments, add an `escalation_failure_count INTEGER DEFAULT 0` column to `message_timeout_tracking` and increment it in the DB to survive restarts.

If `escalation_recipient` is absent from `agent_registry`, the cron emits a `CRITICAL` alert via `OPERATOR_WEBHOOK_URL` (environment variable).

### Reminder Pass

`runReminderPass()` (line 190) runs after the escalation pass. It finds messages that have reached the 50% mark of their timeout window but have not yet been ACK'd:

```sql
WITH escalated_this_tick AS (
  SELECT DISTINCT message_id
  FROM   roadmap.message_timeout_tracking
  WHERE  escalated_at IS NOT NULL
    AND  escalated_at >= now() - interval '30 seconds'  -- this tick only
)
SELECT mtt.message_id, mtt.timeout_at, ml.from_agent, ml.to_agent,
       ml.message_type, ml.correlation_id
FROM   roadmap.message_timeout_tracking mtt
JOIN   roadmap.message_ledger ml ON ml.id = mtt.message_id
WHERE  mtt.timeout_at       < now() + (mtt.timeout_at - mtt.created_at) * 0.5
  AND  mtt.reminder_sent_at IS NULL
  AND  ml.acked_at          IS NULL
  AND  mtt.message_id NOT IN (SELECT message_id FROM escalated_this_tick);
```

**Why the 30-second interval on `escalated_this_tick`:** Without it, `escalated_at IS NOT NULL` would match *all* historically escalated messages, not just those escalated in the current tick. Messages that were escalated in a prior tick, had their `escalated_at` reset (e.g., replay), and re-entered the reminder window would be incorrectly suppressed forever. The interval filter makes the exclusion tick-scoped.

For each candidate, the pass:
1. INSERTs a `reminder` message to `ml.from_agent` from `system:timeout-reminder`.
2. UPDATEs `reminder_sent_at = now()` — idempotent guard against duplicate reminders on subsequent ticks.

---

## ACK Cancels Escalation

**File:** `src/apps/mcp-server/tools/messages/msg-ack.ts`

When a recipient ACKs a message, the handler sets `escalated_at = now()` on the tracking row (line 70–75):

```typescript
await query(
  `UPDATE roadmap.message_timeout_tracking
   SET escalated_at = now()
   WHERE message_id = $1 AND escalated_at IS NULL`,
  [args.message_id],
);
```

This causes the escalation pass to skip the row (`WHERE escalated_at IS NULL` no longer matches), cancelling any pending escalation. The ACK handler is idempotent: if `acked_at` is already set, it returns the existing outcome without overwriting.

Similarly, `msg_reply` sets `resolved_at = now()` in `message_timeout_tracking` to cancel escalation for correlation-tracked reply messages.

---

## Dead Letter / NACK Handling

**File:** `src/infra/messaging/cross-host-relay.ts` (line 428)

When cross-host delivery fails after all retries, `insertDeliveryNack()` writes a `nack` message to `message_ledger` addressed to the original sender:

```json
{
  "from_agent":   "system:cross-host-relay",
  "to_agent":     "<original_sender>",
  "message_type": "nack",
  "message_content": {
    "original_message_id": "<id>",
    "failure_reason":      "delivery_failed_all_retries",
    "retriable":           true,
    "details":             "<error string>",
    "timestamp":           "<ISO-8601>"
  }
}
```

**Dispatch-gate NACKs** (defined in design, implemented in the dispatch middleware) fire immediately — before the message is even inserted — for:
- `agent_not_found` — `to_agent` absent from `agent_registry`
- `recipient_blocked` — `to_agent` has `trust_tier = 'blocked'`

These NACKs carry `"retriable": false`.

---

## Monitoring

### Key Metrics

| Metric | Query | Alert threshold |
|---|---|---|
| Escalation backlog | `SELECT COUNT(*) FROM roadmap.message_timeout_tracking WHERE escalated_at IS NULL AND timeout_at < now()` | > 10 for > 5 min |
| Poison pill count | `SELECT COUNT(*) FROM roadmap.message_timeout_tracking WHERE escalation_recipient = 'POISON_PILL_DEAD_LETTER'` | > 0 (any count) |
| Escalation rate | Rows with `escalated_at NOT NULL` per 5-min interval | Spike = sender/recipient relationship failure |
| Reminder rate | `reminder_sent_at NOT NULL` inserts per 5-min interval | Spike without corresponding escalations = agents ignoring messages |
| Depth violation | `SELECT COUNT(*) FROM roadmap.message_ledger WHERE message_type = 'escalation_notice' AND (ack_required = true OR timeout_seconds IS NOT NULL)` | > 0 (invariant violation) |

### Log Tags

All log lines from the timeout cron are prefixed `[TimeoutCron]` for easy filtering. Key events:

- `[TimeoutCron] Starting timeout sweep` / `Timeout sweep complete` — sweep boundaries
- `[TimeoutCron] Escalation pass: found N candidates` — per-tick candidate count
- `[TimeoutCron] Escalation: message <id> escalated to <recipient>` — successful escalation
- `[TimeoutCron] Escalation failed for message <id> (attempt N)` — per-message failure
- `[TimeoutCron] Message <id> marked as poison pill after N failures` — quarantine event
- `[TimeoutCron] CRITICAL: message <id> has no escalation_recipient` — operator webhook trigger
- `[TimeoutCron] Reminder pass: found N candidates` — per-tick reminder count

---

## Reliability Guarantees

| Guarantee | Mechanism |
|---|---|
| Exactly-once escalation per message under concurrent workers | `FOR UPDATE SKIP LOCKED` in `candidates` CTE partitions rows across workers |
| No escalation cascade | `escalation_notice` always has `ack_required: false`; depth structurally bounded at 1 |
| Poison pill never stalls sweep | Per-message try/catch; quarantine after 3 failures; sweep always continues |
| No duplicate reminders | `reminder_sent_at` guard + idempotent UPDATE |
| Escalation supersedes reminder in same tick | Escalation pass runs first; reminder pass excludes `escalated_this_tick` |
| Cron survives pod restarts | Schema gate + idempotency check before `setInterval` registration |
| ACK cancels pending escalation | `msg_ack` sets `escalated_at = now()` on `message_timeout_tracking` |

---

## Migration History

| Migration file | Description |
|---|---|
| `database/migrations/101-p833-a2a-message-envelope.sql` | Creates `message_timeout_tracking`, `message_type_contract`; seeds contract rows for `task`, `directive`, `request_assistance` |
| `scripts/migrations/106-p835-timeout-escalated-at.sql` | Adds `escalated_at TIMESTAMPTZ` to `message_timeout_tracking`; creates `idx_mtt_unescalated` partial index |
| `database/migrations/113-fix-message-timeout-tracking-reminder-sent-at.sql` | Backfills missing `reminder_sent_at` column that caused recurring TimeoutCron failures |

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P833 | Phase 1+2 — message envelope schema, `message_timeout_tracking` table creation |
| P834 | Phase 3 — identity/trust gating; `trust_tier` enforcement used by dispatch-gate NACKs |
| P836 | Cross-host relay; source of `insertDeliveryNack()` for failed cross-host deliveries |
| P856 | Agent liveness probe (A2A-based health check that exercises the same message paths) |
