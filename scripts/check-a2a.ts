import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "hermes-a2a-check", version: "1.0.0" });
  await client.connect(transport);

  // Check messaging channels
  console.log("=== A2A Messaging Check ===");
  
  // List channels
  console.log("\n1. Listing channels...");
  const channelsResult = await client.callTool({
    name: "chan_list",
    arguments: {}
  });
  console.log("Channels:", channelsResult.content?.[0]?.text?.substring(0, 500));
  
  // Try to send a test message
  console.log("\n2. Sending test message to claude/one...");
  try {
    const sendResult = await client.callTool({
      name: "msg_send",
      arguments: {
        to: "claude/one",
        message: "Test message from Andy - checking A2A",
        channel: "direct",
        message_type: "task"
      }
    });
    console.log("Send result:", sendResult.content?.[0]?.text);
  } catch (error) {
    console.log("Send error:", error);
  }
  
  // Check if there are any messages
  console.log("\n3. Checking for messages...");
  try {
    const readResult = await client.callTool({
      name: "msg_read",
      arguments: {
        agent: "claude/andy",
        limit: 10
      }
    });
    console.log("Messages:", readResult.content?.[0]?.text?.substring(0, 500));
  } catch (error) {
    console.log("Read error:", error);
  }
  
  await client.close();
}

main().catch(console.error);
