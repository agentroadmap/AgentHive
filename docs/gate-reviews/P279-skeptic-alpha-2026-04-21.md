# P279 SKEPTIC ALPHA GATE REVIEW
**Date:** 2026-04-21
**Agent:** skeptic-alpha (worker-6827)
**Decision:** SEND BACK to DRAFT (hold state, maturity set to new)

## Summary
P279 proposes an Agent Communication Protocol for bidirectional agent-orchestrator dialogue. The concept is sound — spawned agents need a feedback channel beyond exit codes. However, the RFC is structurally incomplete and cannot advance.

## Critical Findings

### 1. NO ACCEPTANCE CRITERIA (HARD BLOCKER)
The `list_ac` MCP action fails with "Cannot read properties of undefined (reading 'trim')". Whether ACs were corrupted by the known character-splitting bug (P156/P192) or never written, a proposal without measurable ACs cannot advance. Per the RFC standard: proposals must have "Structurally defined Acceptance Criteria (AC) with clear functions/tests."

### 2. MASSIVE SCHEMA MISMATCH
The `message_ledger` table has a CHECK constraint:
```sql
CHECK (message_type = ANY (ARRAY['text', 'task', 'notify', 'ack', 'error', 'event']))
```
The proposal proposes message types: `sos`, `ask`, `decision`, `report` — and response types: `reply`, `command`.

**None of these are valid per the DB constraint.** An agent attempting to INSERT a message with `message_type = 'sos'` would get a constraint violation error.

The existing DDL migration `008_agent_comm_protocol.sql` only adds `reply_to` and `metadata` columns — it does NOT expand the type constraint. This is a fundamental gap.

### 3. EXISTING INFRASTRUCTURE INVISIBLE
Substantial messaging infrastructure already exists:

| Component | Location | Status |
|-----------|----------|--------|
| `message_ledger` table | roadmap schema | Live, with FK constraints |
| `fn_notify_new_message()` trigger | DB function | Fires on INSERT, sends pg_notify |
| `messaging.ts` | `src/core/messaging/agent-messaging/` | sendMessage, getMessages, getReplyChain |
| `a2a-dispatcher.ts` | `scripts/` | Filters on `message_type = 'task'` |
| `discord-bridge.ts` | `src/infra/discord/` | Writes Discord messages to message_ledger |
| `reply_to` column | DB (via 008 migration) | Already deployed |
| `metadata` column | DB (via 008 migration) | Already deployed |

The proposal reads as if messaging needs to be built from scratch. It should extend `messaging.ts`, not create a parallel system.

### 4. HANDLER SPECS ARE VAPOR
The four orchestrator handlers are described in one line each with no implementation details:

- **handleSOS**: "log escalation, mark dispatch blocked, send ack"
  - Log WHERE? Which table?
  - Mark blocked HOW? What UPDATE? What column? The `squad_dispatch` table has `offer_status` — does `blocked` exist as a status?
  - Send ack as what message_type? (Hint: `ack` is a valid type, but would need reply threading)

- **handleAsk**: "lookup context, send answer"
  - Lookup FROM WHERE? Knowledge base? Proposal content? Source code?
  - What's the fallback if context isn't found?

- **handleDecision**: "auto-decide or escalate"
  - What decision framework? When auto-decide vs escalate?
  - Escalate TO WHOM? Discord channel? Human? Another agent?

- **handleReport**: "log it"
  - Same question — WHERE?

### 5. ZERO ORCHESTRATOR INTEGRATION
Grep across all orchestrator scripts (`orchestrator.ts`, `orchestrator-refined.ts`, `orchestrator-unlimited.ts`, `a2a-dispatcher.ts`) returns ZERO results for `sos`, `handleSOS`, `handleAsk`, `handleDecision`, or `handleReport`.

There is no LISTEN/NOTIFY consumer in the orchestrator. There are no handler stubs. There is no code.

### 6. buildCommProtocol() DOES NOT EXIST
The "Agent Injection" section references `buildCommProtocol()` to inject communication instructions into spawned agent tasks. This function does not exist anywhere in the codebase. No specification of:
- What instructions it injects
- How it formats them (prompt template?)
- Where it plugs into `spawnAgent()`
- How agents discover the MCP messaging tools
- Token budget per spawn

## Secondary Issues

### 7. Proposal Type Mismatch
Type `component` doesn't fit — this is a protocol/architecture proposal that defines message type contracts, handler behaviors, transport layer, and injection patterns.

### 8. Alternatives Analysis is Lazy
Five one-line dismissals with no evidence:
- "Shared DB polling — higher latency" (How much? Is it acceptable?)
- "Stderr signaling — fragile, not durable" (Agreed, but what about for ephemeral status updates?)
- "Unix signals — not cross-host" (Valid, but most agents run on same host)
- "gRPC streaming — overkill" (Assertion, not analysis)
- "Webhook callbacks — adds auth complexity" (Auth is solvable; cross-host federation needs this)

### 9. Cross-Host Compatibility (P282)
pg_notify only works within a single Postgres instance. P282 (Federation) envisions multi-host, multi-product deployments. The proposal doesn't acknowledge this limitation or provide a transport abstraction layer.

### 10. Prompt Cost Unjustified
"Adds ~50 lines to every spawned agent prompt" — no cost/benefit analysis vs alternatives like:
- MCP tool discovery (agents already use this for memory, KB, etc.)
- ENV variable injection
- Runtime config file

## What's Needed to Advance

1. **Write actual ACs** with measurable pass/fail criteria
   - "AC-1: Agent can send sos message via MCP; orchestrator receives it within 5 seconds"
   - "AC-2: Orchestrator handleSOS blocks dispatch and sends ack reply within 10 seconds"
   - "AC-3: Agent can ask question; orchestrator responds with relevant context"
   - "AC-4: message_type constraint expanded to include sos/ask/decision/report/reply/command"

2. **Write migration to expand type constraint**
   ```sql
   ALTER TABLE roadmap.message_ledger 
   DROP CONSTRAINT message_ledger_type_check,
   ADD CONSTRAINT message_ledger_type_check CHECK (
     message_type = ANY (ARRAY['text','task','notify','ack','error','event','sos','ask','decision','report','reply','command'])
   );
   ```

3. **Acknowledge and extend existing messaging.ts** — don't create a parallel system

4. **Specify handler implementations** with SQL functions, MCP actions, and table references

5. **Write buildCommProtocol() spec** — what instructions, how injected, token budget

6. **Cost/benefit analysis** vs MCP tool-based discovery pattern

7. **Resolve pg_notify limitation** for P282 cross-host compatibility — define transport abstraction

## Dependencies
No blocking dependencies were identified. P282 (Federation) is a related consideration but per the dependency rule, does not block advancement — it should be tracked as a future constraint.

## Artifacts
- `database/ddl/v4/008_agent_comm_protocol.sql` — deployed (reply_to + metadata columns only)
- `src/core/messaging/agent-messaging/messaging.ts` — existing messaging module
- No handler code exists
- No buildCommProtocol() exists
- No orchestrator LISTEN/NOTIFY consumer exists
