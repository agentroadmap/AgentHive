const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

const results = [];
let client;

function log(test, status, detail = "") {
  const entry = { test, status, detail, ts: new Date().toISOString() };
  results.push(entry);
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "WARN" ? "⚠️" : "⏭️";
  console.log(`${icon} ${test}${detail ? " — " + detail : ""}`);
}

async function runTests() {
  // Connect
  console.log("=== Messaging Tester — A2A Communication Validation ===\n");
  const connectStart = Date.now();
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  client = new Client({ name: "messaging-tester", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const connectMs = Date.now() - connectStart;
  log("MCP Connection", "PASS", `${connectMs}ms`);

  // List available tools
  const tools = await client.listTools();
  const toolNames = tools.tools.map(t => t.name);
  const msgTools = ["msg_send", "msg_read", "chan_list", "chan_subscribe", "chan_subscriptions"];
  const hasAll = msgTools.every(t => toolNames.includes(t));
  log("Tool Registration", hasAll ? "PASS" : "FAIL",
    `${msgTools.filter(t => toolNames.includes(t)).length}/${msgTools.length} messaging tools registered`);

  // === TEST 1: Agent sends direct message ===
  console.log("\n--- TEST 1: Message Delivery (Direct) ---");
  const sendTs = Date.now();
  const sendResult = await client.callTool({
    name: "msg_send",
    arguments: {
      from_agent: "messaging-tester",
      to_agent: "hermes-agent",
      message_content: `messaging-test-${sendTs}`,
      message_type: "text",
      channel: "direct"
    }
  });
  const sendText = sendResult.content?.[0]?.text || "";
  const sendOk = !sendText.includes("⚠️") && !sendText.includes("Failed");
  log("Send Direct Message", sendOk ? "PASS" : "FAIL", sendText.substring(0, 100));

  // === TEST 2: Read messages ===
  console.log("\n--- TEST 2: Message Read ---");
  const readResult = await client.callTool({
    name: "msg_read",
    arguments: { limit: 3 }
  });
  const readText = readResult.content?.[0]?.text || "";
  const hasMessages = readText.includes("messaging-tester") || readText.includes("id:");
  log("Read Messages", hasMessages ? "PASS" : "FAIL", `Got ${readText.length} chars`);

  // === TEST 3: Send to broadcast channel ===
  console.log("\n--- TEST 3: Broadcast Channel ---");
  const bcResult = await client.callTool({
    name: "msg_send",
    arguments: {
      from_agent: "messaging-tester",
      message_content: `broadcast-test-${sendTs}`,
      message_type: "notify",
      channel: "broadcast"
    }
  });
  const bcText = bcResult.content?.[0]?.text || "";
  const bcOk = !bcText.includes("⚠️");
  log("Broadcast Send", bcOk ? "PASS" : "FAIL", bcText.substring(0, 100));

  // === TEST 4: Invalid channel ===
  console.log("\n--- TEST 4: Error Handling (Invalid Channel) ---");
  const errResult = await client.callTool({
    name: "msg_send",
    arguments: {
      from_agent: "messaging-tester",
      message_content: "should-fail",
      channel: "invalid_channel_no_colon"
    }
  });
  const errText = errResult.content?.[0]?.text || "";
  const errHandled = errText.includes("⚠️") || errText.includes("constraint") || errText.includes("Failed");
  log("Invalid Channel Rejected", errHandled ? "PASS" : "WARN",
    errHandled ? "Correctly rejected" : "Not rejected: " + errText.substring(0, 80));

  // === TEST 5: Channel list ===
  console.log("\n--- TEST 5: Channel Operations ---");
  const chanResult = await client.callTool({ name: "chan_list", arguments: {} });
  const chanText = chanResult.content?.[0]?.text || "";
  log("Channel List", chanText.length > 0 ? "PASS" : "FAIL", chanText.substring(0, 120));

  // === TEST 6: Channel subscribe ===
  console.log("\n--- TEST 6: Channel Subscription ---");
  try {
    const subResult = await client.callTool({
      name: "chan_subscribe",
      arguments: {
        agent_identity: "messaging-tester",
        channel: "team:messaging-test",
        subscribe: true
      }
    });
    const subText = subResult.content?.[0]?.text || "";
    const subOk = !subText.includes("⚠️") && !subText.includes("Failed");
    log("Subscribe to Channel", subOk ? "PASS" : "FAIL", subText.substring(0, 100));

    // List subscriptions
    const subsResult = await client.callTool({
      name: "chan_subscriptions",
      arguments: { agent_identity: "messaging-tester" }
    });
    const subsText = subsResult.content?.[0]?.text || "";
    log("List Subscriptions", subsText.length > 0 ? "PASS" : "FAIL", subsText.substring(0, 100));
  } catch (e) {
    log("Subscribe to Channel", "FAIL", e.message?.substring(0, 100));
  }

  // === TEST 7: Blocking read with wait_ms ===
  console.log("\n--- TEST 7: pg_notify Blocking Read ---");
  const blockStart = Date.now();
  // First, do a blocking read on empty queue (should wait)
  const blockResult = await client.callTool({
    name: "msg_read",
    arguments: { limit: 1, wait_ms: 3000 }
  });
  const blockMs = Date.now() - blockStart;
  const blockText = blockResult.content?.[0]?.text || "";
  // If queue had messages it returns fast; if empty it waits
  log("Blocking Read", blockMs >= 500 ? "PASS" : "WARN",
    `Returned in ${blockMs}ms (wait_ms=3000)`);

  // === TEST 8: A2A round-trip ===
  console.log("\n--- TEST 8: A2A Round-Trip ---");
  const rtTs = Date.now();
  const rtSend = await client.callTool({
    name: "msg_send",
    arguments: {
      from_agent: "messaging-tester",
      to_agent: "claude/one",
      message_content: `roundtrip-test-${rtTs}`,
      message_type: "task",
      channel: "direct"
    }
  });
  const rtSendText = rtSend.content?.[0]?.text || "";
  const rtSendOk = !rtSendText.includes("⚠️");
  log("A2A Send (tester→claude/one)", rtSendOk ? "PASS" : "FAIL", rtSendText.substring(0, 80));

  // Read as recent messages to verify visibility
  const rtRead = await client.callTool({ name: "msg_read", arguments: { limit: 5 } });
  const rtReadText = rtRead.content?.[0]?.text || "";
  const rtVisible = rtReadText.includes(`roundtrip-test-${rtTs}`);
  log("A2A Message Visible", rtVisible ? "PASS" : "FAIL",
    rtVisible ? "Message found in read" : "Message NOT found");

  // === TEST 9: Message type variety ===
  console.log("\n--- TEST 9: Message Types ---");
  const types = ["task", "notify", "ack", "error", "event", "text"];
  for (const mt of types) {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: "messaging-tester",
        message_content: `type-test-${mt}-${Date.now()}`,
        message_type: mt,
        channel: "system"
      }
    });
    const t = r.content?.[0]?.text || "";
    log(`Type: ${mt}`, !t.includes("⚠️") ? "PASS" : "FAIL", t.substring(0, 60));
  }

  // === Summary ===
  console.log("\n=== SUMMARY ===");
  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const warn = results.filter(r => r.status === "WARN").length;
  console.log(`Total: ${results.length} | PASS: ${pass} | FAIL: ${fail} | WARN: ${warn}`);
  console.log(`Connection latency: ${connectMs}ms`);
  console.log(`Health: ${fail === 0 ? (warn === 0 ? "🟢 HEALTHY" : "🟡 DEGRADED") : "🔴 DEGRADED"}`);

  if (fail > 0) {
    console.log("\nFailed tests:");
    results.filter(r => r.status === "FAIL").forEach(r => console.log(`  - ${r.test}: ${r.detail}`));
  }

  await client.close();
  return { pass, fail, warn, connectMs, results };
}

runTests().catch(e => {
  console.error("FATAL:", e.message);
  if (client) try { client.close(); } catch(_){}
  process.exit(1);
});
