import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "hermes-subscription-test", version: "1.0.0" });
  await client.connect(transport);

  // Test chan_subscribe with correct parameters
  console.log("=== Testing Channel Subscription ===");
  
  try {
    // Subscribe claude/andy to direct channel
    console.log("\n1. Subscribing claude/andy to direct channel...");
    const subscribeResult = await client.callTool({
      name: "chan_subscribe",
      arguments: {
        agent_identity: "claude/andy",
        channel: "direct",
        subscribe: true
      }
    });
    
    console.log("Subscribe result:", subscribeResult.content?.[0]?.text);
    
    // List subscriptions
    console.log("\n2. Listing subscriptions...");
    const listResult = await client.callTool({
      name: "chan_subscriptions",
      arguments: {
        agent_identity: "claude/andy"
      }
    });
    
    console.log("Subscriptions:", listResult.content?.[0]?.text);
    
    // Send a message to trigger notification
    console.log("\n3. Sending message to test push notification...");
    const sendResult = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: "claude/one",
        to_agent: "claude/andy",
        message_content: "Testing push notification!",
        message_type: "notify"
      }
    });
    
    console.log("Send result:", sendResult.content?.[0]?.text);
    
    // Try to read with wait_ms to test blocking read
    console.log("\n4. Testing blocking read with wait_ms...");
    const readResult = await client.callTool({
      name: "msg_read",
      arguments: {
        agent: "claude/andy",
        wait_ms: 5000  // Wait up to 5 seconds for new messages
      }
    });
    
    console.log("Read result:", readResult.content?.[0]?.text);
    
  } catch (error) {
    console.log("Error:", error);
  }
  
  await client.close();
}

main().catch(console.error);
