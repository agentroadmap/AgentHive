import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "hermes-table-creator", version: "1.0.0" });
  await client.connect(transport);

  console.log("=== Creating channel_subscription table via MCP ===\n");

  // Try to create the table using MCP tools
  // First, let's check if we can use a SQL execution tool
  try {
    // Try to subscribe - this will fail if table doesn't exist
    console.log("Testing chan_subscribe...");
    const result = await client.callTool({
      name: "chan_subscribe",
      arguments: {
        agent_identity: "claude/andy",
        channel: "direct",
        subscribe: true
      }
    });
    
    console.log("Result:", result.content?.[0]?.text);
    
    if (result.content?.[0]?.text?.includes("does not exist")) {
      console.log("\nTable doesn't exist. Need to apply migration manually.");
      console.log("Run: psql -h 127.0.0.1 -U admin -d agenthive -f database/ddl/016-channel-subscriptions.sql");
    }
    
  } catch (error) {
    console.log("Error:", error.message);
  }

  await client.close();
}

main().catch(console.error);
