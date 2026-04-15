import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "hermes-subscription-test", version: "1.0.0" });
  await client.connect(transport);

  // List all tools to see if subscription tools are available
  console.log("=== Checking Available Tools After Restart ===");
  const tools = await client.listTools();
  
  const messageTools = tools.tools.filter(t => 
    t.name.includes('msg') || t.name.includes('chan') || t.name.includes('message')
  );
  
  console.log("\nMessage-related tools:");
  for (const tool of messageTools) {
    console.log(`  - ${tool.name}: ${tool.description?.substring(0, 100)}`);
  }
  
  // Test subscription tools
  console.log("\n=== Testing Subscription Tools ===");
  
  try {
    // Test chan_subscribe
    console.log("\n1. Testing chan_subscribe...");
    const subscribeResult = await client.callTool({
      name: "chan_subscribe",
      arguments: {
        agent_identity: "claude/andy",
        channel: "direct",
        subscribe: true
      }
    });
    
    console.log("Subscribe result:", subscribeResult.content?.[0]?.text);
    
    // Test chan_subscriptions
    console.log("\n2. Testing chan_subscriptions...");
    const listResult = await client.callTool({
      name: "chan_subscriptions",
      arguments: {
        agent_identity: "claude/andy"
      }
    });
    
    console.log("Subscriptions:", listResult.content?.[0]?.text);
    
    // Test sending a message to trigger notification
    console.log("\n3. Testing message send to subscribed agent...");
    const sendResult = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: "claude/one",
        to_agent: "claude/andy",
        message_content: "Testing push notification after restart!",
        message_type: "notify"
      }
    });
    
    console.log("Send result:", sendResult.content?.[0]?.text);
    
    // Test blocking read with wait_ms
    console.log("\n4. Testing blocking read with wait_ms...");
    const readResult = await client.callTool({
      name: "msg_read",
      arguments: {
        agent: "claude/andy",
        wait_ms: 3000  // Wait up to 3 seconds for new messages
      }
    });
    
    console.log("Read result:", readResult.content?.[0]?.text);
    
  } catch (error) {
    console.log("Error:", error);
  }
  
  await client.close();
}

main().catch(console.error);
