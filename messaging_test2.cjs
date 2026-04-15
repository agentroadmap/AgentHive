const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function run() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "messaging-tester", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // Test unfiltered msg_read - what does it actually return?
  console.log("=== Unfiltered msg_read ===");
  let r = await client.callTool({ name: "msg_read", arguments: { limit: 10 } });
  console.log(JSON.stringify(r.content, null, 2));

  // Test with channel filter
  console.log("\n=== msg_read channel=direct ===");
  r = await client.callTool({ name: "msg_read", arguments: { channel: "direct", limit: 5 } });
  console.log(JSON.stringify(r.content, null, 2));

  // Test with channel=broadcast
  console.log("\n=== msg_read channel=broadcast ===");
  r = await client.callTool({ name: "msg_read", arguments: { channel: "broadcast", limit: 5 } });
  console.log(JSON.stringify(r.content, null, 2));

  // Test pg_notify - send and blocking read
  console.log("\n=== pg_notify test: send + blocking read ===");
  const testMsg = "notify-test-" + Date.now();
  // Start blocking read FIRST (in parallel conceptually, but sequentially here with short wait)
  const readPromise = client.callTool({ name: "msg_read", arguments: { channel: "system", wait_ms: 5000, limit: 3 } });
  
  // Small delay then send
  await new Promise(r => setTimeout(r, 500));
  await client.callTool({
    name: "msg_send",
    arguments: {
      from_agent: "messaging-tester",
      message_content: testMsg,
      message_type: "notify",
      channel: "system"
    }
  });

  const readResult = await readPromise;
  console.log("Blocking read result:", JSON.stringify(readResult.content, null, 2));
  console.log("Found test message:", readResult.content?.[0]?.text?.includes(testMsg));

  await client.close();
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
