
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "messaging-tester-pgnotify", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // Test: Blocking read for a specific agent with no new messages
  // Use a unique agent that has no messages targeting it
  console.log("=== pg_notify Blocking Read Test ===");
  console.log("Reading as 'codex' agent with 5s timeout (should have no direct messages)...");
  
  const start = Date.now();
  const resp = await client.callTool({
    name: "msg_read",
    arguments: { agent: "codex", limit: 1, wait_ms: 5000 }
  });
  const elapsed = Date.now() - start;
  
  const text = resp.content[0].text;
  console.log(`Returned in ${elapsed}ms`);
  console.log(`Response: ${text.substring(0, 200)}`);
  
  if (elapsed < 100 && !text.includes("No messages")) {
    console.log("⚠️  Returned immediately with messages (existing queue)");
  } else if (elapsed >= 4900) {
    console.log("⚠️  TIMED OUT — pg_notify trigger is likely missing. Blocking read fell back to timeout.");
  } else if (text.includes("No messages")) {
    console.log("✅ Returned 'No messages' promptly — handler has fast-path for empty queue");
  }

  // Now send a message TO codex, then test blocking read again
  console.log("\n=== pg_notify Round-Trip Test ===");
  const ts = Date.now();
  
  // Start blocking read in background via second connection
  const transport2 = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client2 = new Client({ name: "messaging-tester-listener", version: "1.0.0" }, { capabilities: {} });
  await client2.connect(transport2);
  
  const readPromise = client2.callTool({
    name: "msg_read",
    arguments: { agent: "codex", limit: 1, wait_ms: 8000 }
  });
  
  // Wait a moment then send
  await new Promise(r => setTimeout(r, 200));
  console.log("Sending message to codex...");
  const sendResp = await client.callTool({
    name: "msg_send",
    arguments: {
      from_agent: "messaging-tester",
      to_agent: "codex",
      message_content: `pgnotify-rt-test-${ts}`,
      message_type: "notify",
      channel: "direct"
    }
  });
  console.log("Send result:", sendResp.content[0].text.substring(0, 80));
  
  // Wait for read
  const readStart = Date.now();
  const readResp = await readPromise;
  const readElapsed = Date.now() - readStart;
  
  console.log(`Blocking read returned in ${readElapsed}ms`);
  console.log(`Read result: ${readResp.content[0].text.substring(0, 150)}`);
  
  if (readElapsed < 1000 && readResp.content[0].text.includes(`pgnotify-rt-test-${ts}`)) {
    console.log("✅ pg_notify round-trip WORKS — message delivered via notification");
  } else if (readElapsed >= 7000) {
    console.log("❌ pg_notify BROKEN — blocking read timed out, trigger is missing");
  } else {
    console.log("⚠️  Ambiguous result — check timing and content");
  }

  await client2.close();
  await client.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
