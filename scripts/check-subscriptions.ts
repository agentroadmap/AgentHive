import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "hermes-subscription-checker", version: "1.0.0" });
  await client.connect(transport);

  // Check subscriptions
  console.log("=== Checking Channel Subscriptions ===");
  
  try {
    const result = await client.callTool({
      name: "msg_pg_list_subscriptions",
      arguments: {}
    });
    
    console.log("Subscriptions:", result.content?.[0]?.text);
  } catch (error) {
    console.log("Error listing subscriptions:", error);
  }
  
  // Test subscribing to a channel
  console.log("\n=== Testing Subscription ===");
  
  try {
    const subscribeResult = await client.callTool({
      name: "chan_subscribe",
      arguments: {
        channel: "direct",
        from: "claude/andy",
        subscribe: true
      }
    });
    
    console.log("Subscribe result:", subscribeResult.content?.[0]?.text);
  } catch (error) {
    console.log("Error subscribing:", error);
  }
  
  // Check subscriptions again
  console.log("\n=== Checking Subscriptions After Subscribe ===");
  
  try {
    const result2 = await client.callTool({
      name: "msg_pg_list_subscriptions",
      arguments: {}
    });
    
    console.log("Subscriptions:", result2.content?.[0]?.text);
  } catch (error) {
    console.log("Error listing subscriptions:", error);
  }
  
  await client.close();
}

main().catch(console.error);
