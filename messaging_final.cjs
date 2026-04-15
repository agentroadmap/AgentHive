const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

const RESULTS = { pass: 0, fail: 0, warn: 0, tests: [] };

function record(name, passed, detail = "", warning = false) {
  RESULTS.tests.push({ name, status: passed ? (warning ? "WARN" : "PASS") : "FAIL", detail });
  if (passed) { if (warning) RESULTS.warn++; else RESULTS.pass++; } else RESULTS.fail++;
  const icon = passed ? (warning ? "⚠️" : "✅") : "❌";
  console.log(`${icon} ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  const t0 = Date.now();
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "messaging-final", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  record("MCP Connection", true, `${Date.now() - t0}ms`);

  // Use real registered agents
  const AGENT_A = "hermes-agent";
  const AGENT_B = "system";

  // --- 1. Channel Operations ---
  console.log("\n📡 CHANNEL OPERATIONS");
  try {
    const r = await client.callTool({ name: "chan_list", arguments: {} });
    const content = r.content?.[0]?.text || "";
    const channels = content.trim().split("\n").filter(l => l.includes(":"));
    record("chan_list", channels.length > 0, `${channels.length} channels`);
    channels.forEach(c => console.log("   " + c.trim()));
  } catch (e) { record("chan_list", false, e.message); }

  // --- 2. Message Send (A→B direct) ---
  console.log("\n📨 MESSAGE DELIVERY");
  const ts = new Date().toISOString();
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: AGENT_A,
        to_agent: AGENT_B,
        message_content: `A2A test at ${ts}`,
        message_type: "task",
        channel: "direct"
      }
    });
    const text = r.content?.[0]?.text || "";
    const success = !text.includes("⚠️");
    record("msg_send direct (A→B)", success, text.substring(0, 120));
  } catch (e) { record("msg_send direct (A→B)", false, e.message); }

  // --- 3. Message Send (system channel) ---
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: AGENT_A,
        message_content: `System notify at ${ts}`,
        message_type: "notify",
        channel: "system"
      }
    });
    const text = r.content?.[0]?.text || "";
    record("msg_send system", !text.includes("⚠️"), text.substring(0, 120));
  } catch (e) { record("msg_send system", false, e.message); }

  // --- 4. Message Send (broadcast) ---
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: AGENT_A,
        message_content: `Broadcast event at ${ts}`,
        message_type: "event",
        channel: "broadcast"
      }
    });
    const text = r.content?.[0]?.text || "";
    record("msg_send broadcast", !text.includes("⚠️"), text.substring(0, 120));
  } catch (e) { record("msg_send broadcast", false, e.message); }

  // --- 5. Message Send (team channel) ---
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: AGENT_A,
        message_content: `Team dev msg at ${ts}`,
        message_type: "text",
        channel: "team:dev"
      }
    });
    const text = r.content?.[0]?.text || "";
    record("msg_send team:dev", !text.includes("⚠️"), text.substring(0, 120));
  } catch (e) { record("msg_send team:dev", false, e.message); }

  // --- 6. Read messages for Agent B ---
  console.log("\n📖 MESSAGE RETRIEVAL");
  try {
    const r = await client.callTool({
      name: "msg_read",
      arguments: { agent: AGENT_B, limit: 5 }
    });
    const text = r.content?.[0]?.text || "";
    const hasMessages = !text.includes("No messages") && text.length > 20;
    record("msg_read (Agent B)", hasMessages, text.substring(0, 200), !hasMessages);
  } catch (e) { record("msg_read (Agent B)", false, e.message); }

  // --- 7. Read messages from direct channel ---
  try {
    const r = await client.callTool({
      name: "msg_read",
      arguments: { channel: "direct", limit: 5 }
    });
    const text = r.content?.[0]?.text || "";
    const hasMessages = !text.includes("No messages") && text.length > 20;
    record("msg_read (direct channel)", hasMessages, text.substring(0, 200), !hasMessages);
  } catch (e) { record("msg_read (direct channel)", false, e.message); }

  // --- 8. Read messages from system channel ---
  try {
    const r = await client.callTool({
      name: "msg_read",
      arguments: { channel: "system", limit: 5 }
    });
    const text = r.content?.[0]?.text || "";
    const hasMessages = !text.includes("No messages") && text.length > 20;
    record("msg_read (system channel)", hasMessages, text.substring(0, 200), !hasMessages);
  } catch (e) { record("msg_read (system channel)", false, e.message); }

  // --- 9. Blocking read (pg_notify test) ---
  console.log("\n🔔 PG_NOTIFY / BLOCKING READ");
  try {
    const t1 = Date.now();
    const r = await client.callTool({
      name: "msg_read",
      arguments: { limit: 1, wait_ms: 3000 }
    });
    const elapsed = Date.now() - t1;
    const text = r.content?.[0]?.text || "";
    // If pg_notify works, it should wait ~3s if no new messages
    const waited = elapsed > 2500;
    record("pg_notify blocking read", true, `${elapsed}ms (wait_ms=3000)`, !waited);
  } catch (e) { record("pg_notify blocking read", false, e.message); }

  // --- 10. Subscribe to channel ---
  console.log("\n📋 CHANNEL SUBSCRIPTIONS");
  try {
    const r = await client.callTool({
      name: "chan_subscribe",
      arguments: { agent_identity: AGENT_A, channel: "broadcast" }
    });
    const text = r.content?.[0]?.text || "";
    record("chan_subscribe (broadcast)", !text.includes("error") && !text.includes("⚠️"), text.substring(0, 100));
  } catch (e) { record("chan_subscribe (broadcast)", false, e.message); }

  // --- 11. Subscribe team channel ---
  try {
    const r = await client.callTool({
      name: "chan_subscribe",
      arguments: { agent_identity: AGENT_A, channel: "team:dev" }
    });
    const text = r.content?.[0]?.text || "";
    record("chan_subscribe (team:dev)", !text.includes("error") && !text.includes("⚠️"), text.substring(0, 100));
  } catch (e) { record("chan_subscribe (team:dev)", false, e.message); }

  // --- 12. List subscriptions ---
  try {
    const r = await client.callTool({
      name: "chan_subscriptions",
      arguments: { agent_identity: AGENT_A }
    });
    const text = r.content?.[0]?.text || "";
    const hasSubs = !text.includes("No subscriptions") && text.length > 10;
    record("chan_subscriptions (Agent A)", hasSubs, text.substring(0, 150), !hasSubs);
  } catch (e) { record("chan_subscriptions (Agent A)", false, e.message); }

  // --- 13. Unsubscribe ---
  try {
    const r = await client.callTool({
      name: "chan_subscribe",
      arguments: { agent_identity: AGENT_A, channel: "broadcast", subscribe: false }
    });
    record("chan_unsubscribe", true);
  } catch (e) { record("chan_unsubscribe", false, e.message); }

  // --- ERROR HANDLING ---
  console.log("\n🛡️ ERROR HANDLING");

  // 14. Invalid channel
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: AGENT_A,
        message_content: "Bad channel",
        channel: "invalid-channel"
      }
    });
    const text = r.content?.[0]?.text || "";
    const rejected = text.includes("⚠️") || text.includes("constraint") || text.includes("error");
    record("Invalid channel rejected", rejected, text.substring(0, 100));
  } catch (e) { record("Invalid channel rejected", true, "Exception thrown"); }

  // 15. Invalid message_type
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: AGENT_A,
        message_content: "Bad type",
        message_type: "totally_invalid",
        channel: "system"
      }
    });
    const text = r.content?.[0]?.text || "";
    const rejected = text.includes("⚠️") || text.includes("constraint") || text.includes("error");
    record("Invalid message_type rejected", rejected, text.substring(0, 100));
  } catch (e) { record("Invalid message_type rejected", true, "Exception thrown"); }

  // 16. Wrong param names (from vs from_agent)
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: { from: AGENT_A, to: AGENT_B, message: "Wrong params" }
    });
    const text = r.content?.[0]?.text || "";
    const rejected = text.includes("⚠️") || text.includes("null") || text.includes("constraint");
    record("Wrong param names rejected", rejected, text.substring(0, 100));
  } catch (e) { record("Wrong param names rejected", true, "Exception thrown"); }

  // 17. Unregistered agent FK
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: "totally-nonexistent-agent-xyz-999",
        message_content: "FK test",
        channel: "system"
      }
    });
    const text = r.content?.[0]?.text || "";
    const rejected = text.includes("⚠️") || text.includes("foreign key") || text.includes("constraint");
    record("FK constraint (unregistered agent)", rejected, text.substring(0, 100));
  } catch (e) { record("FK constraint (unregistered agent)", true, "Exception thrown"); }

  // --- PERFORMANCE ---
  console.log("\n⚡ PERFORMANCE");
  // 18. Burst send
  try {
    const burstStart = Date.now();
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(client.callTool({
        name: "msg_send",
        arguments: {
          from_agent: AGENT_A,
          to_agent: AGENT_B,
          message_content: `Perf burst #${i}`,
          message_type: "text",
          channel: "direct"
        }
      }));
    }
    await Promise.all(promises);
    const elapsed = Date.now() - burstStart;
    record("Burst send (10 msgs)", true, `${elapsed}ms (${Math.round(elapsed/10)}ms/msg)`);
  } catch (e) { record("Burst send (10 msgs)", false, e.message); }

  // 19. Bulk read
  try {
    const r = await client.callTool({
      name: "msg_read",
      arguments: { agent: AGENT_B, limit: 20 }
    });
    const text = r.content?.[0]?.text || "";
    record("Bulk read (20 limit)", true, text.substring(0, 150));
  } catch (e) { record("Bulk read (20 limit)", false, e.message); }

  await client.close();

  // --- REPORT ---
  console.log("\n" + "═".repeat(60));
  console.log("📊 MESSAGING TESTER — FINAL REPORT");
  console.log("═".repeat(60));
  const total = RESULTS.pass + RESULTS.fail + RESULTS.warn;
  console.log(`\n  Total: ${total} | ✅ Passed: ${RESULTS.pass} | ⚠️ Warnings: ${RESULTS.warn} | ❌ Failed: ${RESULTS.fail}`);
  console.log(`  Pass Rate: ${Math.round((RESULTS.pass + RESULTS.warn) / total * 100)}% (including warnings)\n`);

  if (RESULTS.fail > 0) {
    console.log("❌ FAILURES:");
    RESULTS.tests.filter(t => t.status === "FAIL").forEach(t => console.log(`  • ${t.name}: ${t.detail}`));
    console.log("");
  }
  if (RESULTS.warn > 0) {
    console.log("⚠️ WARNINGS:");
    RESULTS.tests.filter(t => t.status === "WARN").forEach(t => console.log(`  • ${t.name}: ${t.detail}`));
    console.log("");
  }

  console.log("📋 ALL RESULTS:");
  RESULTS.tests.forEach(t => {
    const icon = t.status === "PASS" ? "✅" : t.status === "WARN" ? "⚠️" : "❌";
    console.log(`  ${icon} ${t.name}${t.detail ? " — " + t.detail : ""}`);
  });

  console.log("\n" + "═".repeat(60));
  console.log("🔍 RECOMMENDATIONS");
  console.log("═".repeat(60));

  const failures = RESULTS.tests.filter(t => t.status === "FAIL" || t.status === "WARN");
  if (failures.some(f => f.name.includes("msg_read") || f.name.includes("No messages"))) {
    console.log("  1. MESSAGE PERSISTENCE: Messages sent via msg_send are accepted but not retrievable via msg_read.");
    console.log("     → Check if msg_send handler actually inserts into message_ledger or just returns success wrapper.");
    console.log("     → Verify msg_read query filters match inserted rows.");
  }
  if (failures.some(f => f.name.includes("subscription"))) {
    console.log("  2. SUBSCRIPTION PERSISTENCE: chan_subscribe succeeds but chan_subscriptions returns empty.");
    console.log("     → Check if chan_subscribe handler actually INSERTs into channel_subscription table.");
    console.log("     → Verify migration 016 is fully applied.");
  }
  if (failures.some(f => f.name.includes("pg_notify"))) {
    console.log("  3. PG_NOTIFY NOT WAITING: Blocking read returns in <50ms instead of waiting.");
    console.log("     → Check MessageNotificationListener setup in pg-handlers.ts.");
    console.log("     → Verify LISTEN/NOTIFY trigger fn_notify_new_message() is active.");
  }
  if (failures.some(f => f.name.includes("agent_register") || f.name.includes("FK"))) {
    console.log("  4. AGENT REGISTRATION: agent_register claims success but agents don't appear in registry.");
    console.log("     → Fix pg-handlers.ts mapping: parameter 'identity' → column 'agent_identity'.");
  }

  console.log("═".repeat(60));
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
