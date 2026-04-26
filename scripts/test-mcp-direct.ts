import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  console.log("=== Testing MCP Server Direct Connection ===\n");
  
  try {
    const transport = new SSEClientTransport(new URL(getMcpUrl()));
    const client = new Client({ name: "hermes-mcp-test", version: "1.0.0" });
    
    console.log("Connecting to MCP server...");
    await client.connect(transport);
    console.log("Connected successfully!\n");
    
    // List tools
    console.log("Listing tools...");
    const tools = await client.listTools();
    console.log(`Total tools: ${tools.tools.length}\n`);
    
    // Check for messaging tools
    const msgTools = tools.tools.filter(t => 
      t.name.includes('msg') || t.name.includes('chan')
    );
    
    console.log("Messaging tools:");
    for (const tool of msgTools) {
      console.log(`  - ${tool.name}`);
    }
    
    // Test msg_send
    console.log("\n=== Testing msg_send ===");
    try {
      const result = await client.callTool({
        name: "msg_send",
        arguments: {
          from_agent: "test-agent",
          to_agent: "claude/andy",
          message_content: "Test message",
          message_type: "task"
        }
      });
      console.log("msg_send result:", result.content?.[0]?.text);
    } catch (error) {
      console.log("msg_send error:", error.message);
    }
    
    // Test chan_subscribe
    console.log("\n=== Testing chan_subscribe ===");
    try {
      const result = await client.callTool({
        name: "chan_subscribe",
        arguments: {
          agent_identity: "claude/andy",
          channel: "direct",
          subscribe: true
        }
      });
      console.log("chan_subscribe result:", result.content?.[0]?.text);
    } catch (error) {
      console.log("chan_subscribe error:", error.message);
    }
    
    await client.close();
    console.log("\n=== Test Complete ===");
    
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
