# Agent Communication Protocol (P279)

Bidirectional, mid-execution messaging between spawned agents and the orchestrator.

---

## Motivation

Before P279 the only feedback channel from a spawned agent was its exit code, observed after termination. This meant:

- Silent mid-run failures (LLM errors, model unavailability, budget exhaustion) went undetected until the agent died.
- Agents had no way to request architectural context or decisions that were outside their scoped task prompt.
- The orchestrator had zero visibility into in-flight work.

P279 introduces four structured signal types and two transport options so agents can surface problems and ask questions in real time.

---

## Transport Layer

### Primary: `message_ledger` (MCP-backed, durable)

Table: `roadmap.message_ledger`

Schema additions (`database/ddl/v4/008_agent_comm_protocol.sql`):

| Column | Type | Purpose |
|--------|------|---------|
| `reply_to` | int8, nullable | Links an orchestrator reply to the agent's original message |
| `metadata` | jsonb, default `{}` | Arbitrary structured payload |

Indexes added:

| Index | Expression | Use |
|-------|-----------|-----|
| `idx_message_ledger_reply_to` | `(reply_to) WHERE reply_to IS NOT NULL` | Fast thread-chain lookup |
| `idx_message_ledger_unread` | `(to_agent, read_at) WHERE read_at IS NULL` | Fast unread polling |

**Notification:** `pg_notify('new_message', ...)` fires on every INSERT via trigger `trg_message_notify`. Agents do not need to poll on a fixed interval; they can block on `msg_read wait_ms=<ms>` instead.

MCP tools exposed:

| Tool | Purpose |
|------|---------|
| `msg_send` | Insert a message row into `message_ledger`. **Schema note:** the `inputSchema` enum for `message_type` lists `task, notify, ack, error, event, text`. P279 types (`sos`, `ask`, `decision`, `report`, `reply`, `command`) bypass this enum via the internal validation path — they are stored verbatim. The constraint mismatch is a known gap pending migration. |
| `msg_read` | Blocking read; returns unread messages (cap: 30 000 ms on `wait_ms`). Wakes on `pg_notify('new_message', ...)`. |
| `msg_ack` | Mark a message acknowledged with outcome `ok`, `reject`, or `noop`. |
| `msg_reply` | Send a reply with `reply_to` and `correlation_id` set automatically from the original message. |
| `msg_wait_reply` | Wait for a correlated reply to a sent message. Looks up `correlation_id` from the original `message_id`, subscribes to `pg_notify` on channel `a2a_msg_<agent>`, and polls every 5 s as fallback. Cap: 5 minutes. On timeout, inserts into `message_timeout_tracking` (idempotent via UNIQUE on `message_id`). |

### Secondary: `A2AMessenger` (TypeScript class, same-host, low-latency)

File: `src/core/runtime/a2a-messenger.ts`

> **Deprecated.** Prefer the MCP `mcp_message` tool surface for all new agents. `A2AMessenger` predates the P833 unified message envelope and its semantics overlap with the MCP tools. It is kept for compatibility with the `RuntimeProvider` abstraction and will be folded into the MCP path or removed in a follow-up to P837.

The class writes to `roadmap.message_ledger` and emits `pg_notify('a2a_messages', ...)` for real-time delivery.

```typescript
import { createA2AMessenger } from '../../core/runtime/a2a-messenger.ts';

const messenger = createA2AMessenger('worker-4512');

// Send
await messenger.send('orchestrator', {
  type: 'sos',
  content: { error: 'model_unavailable', detail: 'xiaomi/mimo-v2 returned 503' }
}, { proposalId: 279 });

// Receive (poll with optional timeout)
const reply = await messenger.recv({ timeoutMs: 5000, messageType: 'reply' });
if (reply) { /* handle */ }
```

Key behaviours:
- `recv()` uses `FOR UPDATE SKIP LOCKED` on the inner `SELECT` so concurrent receivers never claim the same row. It polls every 100 ms until `timeoutMs` elapses.
- `recv()` only surfaces messages where `channel IS NULL OR channel = 'direct'`. Channel-broadcast rows are not returned; use `broadcast()` + a separate subscriber for fan-out.
- Marks `read_at` on delivery; the row stays in `message_ledger` so ACK provenance and timeout escalation tracking are preserved.
- `broadcast(channel, message)` inserts without `to_agent` and emits `pg_notify` on the named channel (not `a2a_messages`).
- `send()` emits `pg_notify('a2a_messages', ...)` for point-to-point delivery. The `msg_wait_reply` tool separately listens on `a2a_msg_<agent>` for correlated reply notifications.

---

## Message Protocol

### Agent → Orchestrator

| `message_type` | Meaning | Expected response |
|----------------|---------|------------------|
| `sos` | Critical failure — LLM error, budget exhausted, model unavailable | `reply` ack + `escalation_log` entry |
| `ask` | Needs architectural context not in task scope | `reply` with answer |
| `decision` | Needs orchestrator authorization before continuing | `reply` with approved/rejected |
| `report` | Informational status update | None |

### Orchestrator → Agent

| `message_type` | Meaning |
|----------------|---------|
| `reply` | Threaded answer — must include `reply_to = <original_msg_id>` |
| `command` | Instruction to carry out: `retry`, `switch_model`, `abort` |

> **Schema note:** The `msg_send` tool's `inputSchema` enumerates `text, task, notify, ack, error, event` for the `message_type` field. P279 types (`sos`, `ask`, `decision`, `report`, `reply`, `command`) are accepted by the internal handler (which uses a looser schema) and stored verbatim in Postgres. There is no DB-level CHECK constraint on `message_type` either; a migration to add one must account for existing rows.

---

## Reply Threading

The `reply_to` column on `message_ledger` forms an upward-walking linked list. Orchestrator replies set `reply_to = <agent_message_id>`:

```sql
INSERT INTO roadmap.message_ledger
  (from_agent, to_agent, channel, message_content, message_type, reply_to)
VALUES
  ('orchestrator', 'worker-4512', 'agent-worker-4512',
   'retry with model xiaomi/mimo-v2', 'reply', <original_msg_id>);
```

Full thread traversal: `getReplyChain(messageId)` in
`src/core/messaging/agent-messaging/messaging.ts:151`. Walks the `replyTo`
chain toward the root and returns messages in chronological order.

**Legacy encoding:** `messaging.ts` also encodes `replyTo` into
`message_type` as `reply:<replyToId>:<type>` for callers that predate the
`reply_to` column. `decodeType()` handles both formats transparently, so
new and old rows can coexist.

---

## Agent Usage — MCP (recommended)

All spawned agents should use the MCP surface. No TypeScript import needed.

**Send SOS:**
```
mcp_message action="msg_send"
  from_agent="worker-4512"
  to_agent="orchestrator"
  message_content="LLM call failed: model xiaomi/mimo-v2 returned 429, budget exhausted"
  message_type="sos"
  proposal_id="279"
```

**Block until orchestrator replies (up to 5 s):**
```
mcp_message action="msg_read"
  agent="worker-4512"
  wait_ms=5000
```

**Send a status report (no reply expected):**
```
mcp_message action="msg_send"
  from_agent="worker-4512"
  to_agent="orchestrator"
  message_content="Migration applied; starting seed phase"
  message_type="report"
  proposal_id="279"
```

---

## Read Tracking

`read_at` (timestamptz, nullable) tracks message consumption.

| Function | File | Line |
|----------|------|------|
| `markRead(message_id, agent)` | `src/apps/mcp-server/tools/messages/pg-handlers.ts` | 309 |
| `unreadCount(agent)` | `src/apps/mcp-server/tools/messages/pg-handlers.ts` | 349 |

The `idx_message_ledger_unread` index covers `(to_agent, read_at) WHERE read_at IS NULL` for efficient inbox polling.

---

## Orchestrator-Side Handling (pending wiring)

The handlers below are specified; wiring into a running loop is the remaining implementation gap.

### handleSOS
Triggered when `message_type = 'sos'` arrives addressed to `orchestrator`:
1. Insert to `escalation_log` with `severity='high'`, `obstacle_type='SOS'`.
2. Mark the associated dispatch/lease as `blocked`.
3. Send `reply` ack via `message_ledger` with `reply_to = <sos_msg_id>`.

### handleAsk
1. Look up context from proposal design / DB.
2. Send `reply` message with the answer.

### handleDecision
1. Auto-decide if rule-based; otherwise escalate.
2. Send `reply` with `approved` or `rejected` outcome.

### handleReport
1. Log to `escalation_log` or feed event (informational).
2. No reply required.

**Wiring point:** a new `orchestrator-message-loop.ts` or integrated into
`src/core/orchestration/orchestrator.ts`. Runs a long-polling loop:
```
mcp_message action="msg_read"
  agent="orchestrator"
  wait_ms=5000
```
…dispatching each received message to the appropriate handler.

**Escalation infrastructure** (`escalation_log`) is already live via P078.
See `src/apps/mcp-server/tools/escalation/index.ts`. Existing caller:
`agent-spawner.ts:460` writes `SPAWN_POLICY_VIOLATION` entries with
`severity='high'`.

---

## buildCommProtocol() — Prompt Injection (pending)

Every spawned agent needs to know how to signal without prior context.
`buildCommProtocol()` should append <400 tokens to the assembled task
prompt at `src/core/orchestration/agent-spawner.ts` (around line 890,
after the maturity hint):

```
## Agent Communication Protocol
Signal the orchestrator mid-execution via MCP:
  sos      → mcp_message action="msg_send" message_type="sos"      (critical failure)
  ask      → mcp_message action="msg_send" message_type="ask"      (need context)
  decision → mcp_message action="msg_send" message_type="decision" (need approval)
  report   → mcp_message action="msg_send" message_type="report"   (status update)
To: orchestrator  |  from_agent: <your_agent_id>  |  proposal_id: <your_proposal_id>
Poll for reply: mcp_message action="msg_read" agent="<your_agent_id>" wait_ms=5000
```

---

## Implementation Status

| Component | File | Status |
|-----------|------|--------|
| Schema: `reply_to` + `metadata` columns | `database/ddl/v4/008_agent_comm_protocol.sql` | Done |
| `A2AMessenger` class (deprecated, compat only) | `src/core/runtime/a2a-messenger.ts` | Done |
| `message_ledger` send/receive | `src/core/messaging/agent-messaging/messaging.ts` | Done |
| MCP `msg_send` / `msg_read` (blocking) | `src/apps/mcp-server/tools/messages/pg-handlers.ts` | Done |
| MCP `msg_ack` / `msg_reply` | `src/apps/mcp-server/tools/messages/msg-ack.ts`, `msg-reply.ts` | Done |
| MCP `msg_wait_reply` (correlated reply waiter) | `src/apps/mcp-server/tools/messages/msg-wait-reply.ts` | Done |
| Reply threading via `getReplyChain` | `src/core/messaging/agent-messaging/messaging.ts:151` | Done |
| Read tracking: `markRead`, `unreadCount` | `src/apps/mcp-server/tools/messages/pg-handlers.ts:309` | Done |
| `escalation_log` infrastructure (P078) | `src/apps/mcp-server/tools/escalation/index.ts` | Done |
| `buildCommProtocol()` prompt injection | `src/core/orchestration/agent-spawner.ts` | **Pending** |
| Orchestrator message loop + handlers | `orchestrator.ts` or new file | **Pending** |
| CHECK constraint for P279 message types | schema migration | **Pending** |
| E2E test: spawn → sos → escalation → ack | `tests/` | **Pending** |

---

## Known Gaps

- **`A2AMessenger` deprecation path:** The class is marked `@deprecated` but has no scheduled removal. P837 follow-up should fold it into the MCP path or delete it entirely.
- **`msg_send` enum constraint mismatch:** The tool's public `inputSchema` lists only `text, task, notify, ack, error, event`. P279 types reach the DB via the internal handler's looser schema. Any new DB-level CHECK constraint must account for existing rows and the dual-schema pattern in `registerMessageTools`.
- **Orchestrator loop not wired:** Without a running message-loop, `sos`/`ask`/`decision` messages accumulate unread. The orchestrator dispatch model (P903 / scripts/orchestrator.ts) needs a companion polling goroutine or integration point.
- **`buildCommProtocol()` not implemented:** Agents spawned today do not receive protocol instructions unless the task prompt happens to include them. Until this function is wired, the protocol is opt-in / ad-hoc.
