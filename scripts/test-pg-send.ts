import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "hermes-pg-send-test", version: "1.0.0" });
  await client.connect(transport);

  // Test msg_pg_send
  console.log("=== Testing msg_pg_send ===");
  
  try {
    const result = await client.callTool({
      name: "msg_pg_send",
      arguments: {
        from_agent: "claude/andy",
        to_agent: "claude/one",
        message_content: "Test A2A message from Andy to One",
        message_type: "task",
        channel: "direct"
      }
    });
    
    console.log("Result:", result.content?.[0]?.text);
    
    // Try to read messages for claude/one
    console.log("\n=== Reading messages for claude/one ===");
    const readResult = await client.callTool({
      name: "msg_pg_read",
      arguments: {
        agent: "claude/one",
        limit: 5
      }
    });
    
    console.log("Messages:", readResult.content?.[0]?.text?.substring(0, 500));
    
  } catch (error) {
    console.log("Error:", error);
  }
  
  await client.close();
}

main().catch(console.error);
