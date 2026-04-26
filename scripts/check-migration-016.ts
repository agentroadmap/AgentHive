import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL(getMcpUrl()));
const client = new Client({ name: "migration-applier", version: "1.0.0" });
await client.connect(transport);

console.log("=== Applying Migration 016: Channel Subscriptions ===\n");

// Test if channel_subscription table exists by trying to use msg_subscribe
try {
  const result = await client.callTool({
    name: "msg_subscribe",
    arguments: {
      agent: "test-agent",
      channel: "test-channel",
      subscribe: true
    }
  });
  console.log("msg_subscribe result:", result.content?.[0]?.text?.substring(0, 200));
} catch (e) {
  console.log("msg_subscribe not available or table doesn't exist");
}

// Check what messaging tools are available
const tools = await client.listTools();
const msgTools = tools.tools.filter(t => 
  t.name.includes("msg_") || 
  t.name.includes("chan_") ||
  t.name.includes("message")
);
console.log("\n=== Available messaging tools ===");
for (const t of msgTools) {
  console.log("- " + t.name);
}

await client.close();
console.log("\n=== Migration 016 needs to be applied via psql ===");
console.log("Run: psql $DATABASE_URL -f database/ddl/016-channel-subscriptions.sql");
