
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes-architect", version: "1.0.0" });
await client.connect(transport);

// First get current proposal
const current = await client.callTool({
  name: "prop_get",
  arguments: { proposalId: "P149" }
});
console.log("Current:", current.content?.[0]?.text?.substring(0, 500));

// Update with enhanced description, ACs, and verification
const result = await client.callTool({
  name: "prop_update",
  arguments: {
    proposalId: "P149",
    description: `The MCP messaging system (msg_send, msg_read, chan_list) is poll-only. Agents must constantly query msg_read to detect new messages, wasting tokens and latency. No subscribe mechanism exists.

The filesystem backend has a working push pattern (notifySubscribedAgents + registerNotificationCallback) but Postgres backend has none. The DB already has pg_notify infrastructure (trg_gate_ready uses it for maturity changes). Apply the same pattern to messaging: agents subscribe to channels, pg_notify fires on new messages, agents wake up only when messages arrive.

This enables true agent-to-agent discussion — multiple agents can subscribe to a team channel, receive real-time notifications, and engage in collaborative conversations without polling overhead.

ARCHITECTURE DECISION: Build on existing pg_notify pattern (trigger + listener) proven with gate pipeline. Reuse the draft chan_subscribe tool shape. Add channel_subscription table for persistence across restarts.`,
    acceptanceCriteria: [
      "AC-1: channel_subscription table created with columns (agent_identity TEXT FK, channel TEXT, subscribed_at TIMESTAMPTZ), unique constraint on (agent_identity, channel), indexes on channel and agent_identity",
      "AC-2: pg_notify trigger fn_message_notify() fires on message_ledger INSERT with payload JSON {message_id, from_agent, to_agent, channel, message_type, created_at} to channel 'new_message'",
      "AC-3: MCP server starts pg_notify listener on 'new_message' that routes notifications to matching subscribers from channel_subscription",
      "AC-4: msg_subscribe MCP tool accepts {agent, channel, subscribe: bool} and inserts/deletes from channel_subscription, returns confirmation with subscription count",
      "AC-5: msg_read accepts optional wait_ms parameter (0-30000ms); when wait_ms > 0, agent waits for pg_notify or timeout",
      "AC-6: chan_list returns {channel, message_count, subscriber_count} with subscriber_count from channel_subscription",
      "AC-7: Direct messaging (to_agent set) pg_notifies that specific agent if subscribed",
      "AC-8: Team channels (team:{name}) support 2+ agents subscribing and receiving real-time notifications",
      "AC-9: Graceful fallback — if pg_notify unavailable, degrades to 5s polling with logged warning",
      "AC-10: All subscription ops audited in audit_log with actor, action, channel, timestamp"
    ],
    verificationRequirements: [
      "VR-1: Unit test: insert message_ledger row, verify pg_notify fired with correct payload",
      "VR-2: Integration test: agent A subscribes to channel, agent B sends message, verify A receives notification within 500ms",
      "VR-3: Test msg_subscribe tool: subscribe, verify row in channel_subscription, unsubscribe, verify removed",
      "VR-4: Test chan_list returns subscriber_count matching subscriptions",
      "VR-5: Test wait_ms timeout: set wait_ms=1000, no message sent, verify timeout response",
      "VR-6: Test direct message notification: agent A subscribes direct, agent B DMs A, verify A notified",
      "VR-7: Test fallback: mock pg_notify failure, verify polling fallback works",
      "VR-8: Test audit_log entries for subscribe/unsubscribe operations"
    ]
  }
});
console.log("\nUpdate result:", result.content?.[0]?.text);

await client.close();

