# AgentHive MCP Messaging System Architecture Research (P149)

## Overview
This document details the current architecture of the AgentHive MCP messaging system, focusing on channel subscriptions and push notifications. It covers tool implementations, database schema, pg_notify infrastructure, MCP tool registration patterns, agent identity system, and gaps that P149 (channel subscription and push notifications) should address.

## Current Messaging Architecture

### Tool Implementations
The MCP messaging system provides three primary tools: `chan_list`, `msg_read`, `msg_send`, and a newer `chan_subscribe` tool (defined but not fully integrated). These tools are implemented in two backends: filesystem (default) and Postgres (when database provider is Postgres).

#### Filesystem Backend (Core Class)
- **Location**: `/src/core/roadmap.ts` (lines 6430‑6500 for `sendMessage`, lines 6501‑6590 for subscription management).
- **Flow**:
  1. Messages are stored as Markdown files in `.roadmap/messages/` (e.g., `PUBLIC.md`, `group‑project.md`, `private‑alice‑bob.md`).
  2. `sendMessage` appends a timestamped log entry, optionally auto‑commits via Git.
  3. After writing, it calls `notifySubscribedAgents` to trigger in‑memory callbacks for agents subscribed to that channel.
- **Subscription Storage**: JSON file at `.roadmap/local/subscriptions.json` mapping agent → list of channels.
- **Push Notifications**: In‑process callbacks registered via `registerNotificationCallback`. When a message is sent, subscribed agents (excluding sender) receive a callback with channel, from, text, and timestamp.

#### Postgres Backend (PgMessagingHandlers)
- **Location**: `/src/apps/mcp-server/tools/messages/pg-handlers.ts`.
- **Flow**:
  1. `sendMessage` inserts a row into `message_ledger` with columns: `from_agent`, `to_agent`, `channel`, `message_content`, `message_type`, `proposal_id`.
  2. `readMessages` queries `message_ledger` with optional `agent` or `channel` filter, ordered by `created_at DESC`.
  3. `listChannels` returns distinct `channel` values from `message_ledger` with message counts.
- **Limitations**: No subscription table, no push‑notification mechanism. Agents must poll `msg_read` with `since` parameter to detect new messages.

### Tool Registration Pattern
Tools are defined in `/src/apps/mcp-server/tools/messages/index.ts`. Each tool is created using `createSimpleValidatedTool` with a JSON schema, then registered via `server.addTool`. The pattern is consistent across all MCP tools:

1. Define JSON schema for input validation.
2. Create a `McpToolHandler` object with `name`, `description`, `inputSchema`, and `handler` function.
3. Register with `server.addTool(handler)`.

For Postgres‑backed tools, registration happens in `/src/apps/mcp-server/server.ts` (lines 410‑445) where the server dynamically imports `PgMessagingHandlers` and registers `msg_send`, `msg_read`, `chan_list` with simpler schemas (different parameter names: `from_agent`, `message_content`, etc.).

### Existing `chan_subscribe` Tool (Draft)
A `chan_subscribe` tool is already defined in the messages index file (lines 86‑153) with schema for `channel`, `from`, and `subscribe` boolean. The handler delegates to `core.subscribeToChannel` / `unsubscribeFromChannel`. However, this tool is **not registered** in the filesystem backend’s `registerMessageTools` function (only `chan_list`, `msg_read`, `msg_send` are added). It appears to be a placeholder for future implementation.

## Database Schema

### `message_ledger` Table
- **Location**: `/database/ddl/roadmap-ddl-v3.sql` (lines 1061‑1085).
- **Columns**:
  - `id` (int8, PK)
  - `from_agent` (text, FK to `agent_registry`)
  - `to_agent` (text, nullable; NULL = broadcast)
  - `channel` (text, nullable; regex constraint: `^(direct|team:.+|broadcast|system)$`)
  - `message_content` (text)
  - `message_type` (text; check: `'task','notify','ack','error','event'`)
  - `proposal_id` (int8, FK to `proposal`, nullable)
  - `created_at` (timestamptz, default now)
- **Indexes**: `idx_message_from`, `idx_message_to`, `idx_message_created`, `idx_message_proposal`.
- **Row Level Security**: Defined in migration scripts but not enabled by default.

### `agent_registry` Table
- **Location**: Same DDL file, lines 81‑101.
- **Columns**: `id`, `agent_identity` (unique), `agent_type`, `role`, `skills`, `preferred_model`, `status`, `github_handle`, `created_at`, `updated_at`.
- **Purpose**: Central registry of all agents (human/AI). `agent_identity` is the stable handle used across all tables.

### No Channel Subscription Table
There is **no database table** for channel subscriptions. The filesystem backend uses a JSON file; the Postgres backend has no subscription storage.

## pg_notify Infrastructure

### Existing Triggers and Listeners
- **`trg_gate_ready`**: Trigger on `proposal.maturity_state` update that fires `pg_notify('proposal_gate_ready', ...)` and enqueues a gate transition.
- **`fn_notify_gate_ready()`**: PL/pgSQL function that inserts into `transition_queue` and sends notifications on channels `proposal_gate_ready` and `transition_queued`.
- **PipelineCron** (`/src/core/pipeline/pipeline-cron.ts`): Listens for `proposal_maturity_changed`, `transition_queued`, and `proposal_gate_ready` notifications. Uses `LISTEN`/`NOTIFY` pattern with a dedicated listener client.

### Pattern for Real‑Time Events
1. **Database trigger** fires `pg_notify(channel_name, payload)`.
2. **Application listener** (PipelineCron) receives the notification and triggers downstream processing.
3. **Fallback polling** ensures events are not lost if notifications are missed.

### Current Channels
- `proposal_gate_ready`
- `transition_queued`
- `proposal_maturity_changed` (referenced but not defined in current DDL)

No existing pg_notify channels for messaging events.

## Agent Identity System
- Agents are identified by `agent_identity` (text) in `agent_registry`.
- Messaging tools accept a `from` (or `from_agent`) parameter that should correspond to an `agent_identity`.
- The Postgres backend does not validate `from_agent` against `agent_registry` (foreign key constraint exists but not enforced in the tool).
- Agent identity is used for subscriptions (filesystem) and as `from_agent`/`to_agent` in `message_ledger`.

## Gaps and Recommendations for P149

### Gaps
1. **No Subscription Storage in Postgres**: The filesystem subscription JSON is not replicated in the database, limiting scalability and persistence across sessions.
2. **No Push Notifications in Postgres Backend**: Agents must poll `msg_read` to detect new messages, which is inefficient.
3. **`chan_subscribe` Tool Not Integrated**: The draft tool exists but is not registered in the filesystem backend and has no Postgres implementation.
4. **No pg_notify Channel for Messaging**: No triggers on `message_ledger` inserts to notify subscribed agents.
5. **Channel Model Limitations**: The `channel` column regex restricts channels to a fixed set (`direct`, `team:.*`, `broadcast`, `system`). Dynamic user‑defined channels (like `project`) are not allowed in the Postgres schema.
6. **Agent Identity Validation**: Messaging tools do not verify that `from_agent`/`to_agent` are registered agents.

### Recommendations for P149 Implementation
1. **Create `channel_subscription` Table**:
   - Columns: `agent_identity` (FK), `channel` (text), `subscribed_at` (timestamptz).
   - Support both dynamic channel names (e.g., `project`) and predefined types.
2. **Add pg_notify Trigger on `message_ledger`**:
   - Trigger after insert that notifies a channel like `new_message` with payload containing `channel`, `from_agent`, `message_id`, etc.
3. **Implement pg_notify Listener in MCP Server**:
   - Extend the existing listener pattern (PipelineCron) to also listen for `new_message` notifications.
   - Deliver push notifications to subscribed agents via a callback mechanism (e.g., WebSocket, SSE, or in‑process callback if MCP server is local).
4. **Enhance `chan_subscribe` Tool**:
   - Register the existing `chan_subscribe` tool for both filesystem and Postgres backends.
   - Implement `subscribe`/`unsubscribe` methods that update the new `channel_subscription` table.
5. **Update `chan_list` to Return Subscribed Channels**:
   - Optionally include subscription status in the channel list.
6. **Validate Agent Identity**:
   - Ensure `from_agent` exists in `agent_registry` before sending.
   - For `to_agent`, validate if provided.
7. **Consider Channel Types**:
   - Relax the regex constraint to allow arbitrary channel names (or add a `channel_type` column).
   - Keep backward compatibility with existing `direct`, `team:*`, `broadcast`, `system` values.

### Architecture Alignment
- The proposal should reuse the existing pg_notify pattern (trigger + listener) already proven with the gate pipeline.
- Subscription storage should be moved to the database for persistence across server restarts.
- The `chan_subscribe` tool already has the right shape; it needs a backend implementation and registration.

## Files Examined
- `/src/core/roadmap.ts` (lines 6430‑6590)
- `/src/apps/mcp-server/tools/messages/index.ts`
- `/src/apps/mcp-server/tools/messages/handlers.ts`
- `/src/apps/mcp-server/tools/messages/pg-handlers.ts`
- `/src/apps/mcp-server/server.ts` (lines 410‑445)
- `/database/ddl/roadmap-ddl-v3.sql` (message_ledger, agent_registry)
- `/database/ddl/013-gate-pipeline-wiring.sql` (pg_notify example)
- `/src/core/pipeline/pipeline-cron.ts` (listener pattern)

## Conclusion
The current messaging system provides basic send/read functionality but lacks efficient push notifications and a centralized subscription store. P149 should introduce a database‑backed subscription table, a pg_notify trigger on `message_ledger`, and integrate the existing `chan_subscribe` tool to enable real‑time message delivery. This aligns with the established pg_notify pattern used for gate pipeline events and will significantly improve agent coordination efficiency.