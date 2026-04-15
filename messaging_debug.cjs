const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "messaging-debug", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  console.log("=== DEBUG: Check registered agents ===");
  try {
    const r = await client.callTool({ name: "agent_list", arguments: {} });
    console.log(r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DEBUG: Check agent_registry via sql ===");
  try {
    const r = await client.callTool({
      name: "sql_query",
      arguments: { query: "SELECT agent_identity, agent_type, status FROM roadmap.agent_registry ORDER BY created_at DESC LIMIT 10" }
    });
    console.log(r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DEBUG: Check message_ledger recent rows ===");
  try {
    const r = await client.callTool({
      name: "sql_query",
      arguments: { query: "SELECT id, from_agent, to_agent, channel, message_type, message_content, created_at FROM roadmap.message_ledger ORDER BY created_at DESC LIMIT 10" }
    });
    console.log(r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DEBUG: Check channel_subscription table ===");
  try {
    const r = await client.callTool({
      name: "sql_query",
      arguments: { query: "SELECT * FROM roadmap.channel_subscription ORDER BY created_at DESC LIMIT 10" }
    });
    console.log(r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DEBUG: Try msg_send with correct params (from sql registered agent) ===");
  // Register test agent via SQL
  try {
    await client.callTool({
      name: "sql_exec",
      arguments: { query: "INSERT INTO roadmap.agent_registry (agent_identity, agent_type, status) VALUES ('debug-test-agent', 'system', 'active') ON CONFLICT (agent_identity) DO NOTHING" }
    });
    console.log("Registered debug-test-agent via SQL");

    // Now send from that agent
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: "debug-test-agent",
        to_agent: "debug-test-agent",
        message_content: "Self-message debug test",
        message_type: "text",
        channel: "direct"
      }
    });
    console.log("msg_send result:", r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DEBUG: Read messages after send ===");
  try {
    const r = await client.callTool({
      name: "msg_read",
      arguments: { agent: "debug-test-agent", limit: 5 }
    });
    console.log(r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DEBUG: Check message_ledger after send ===");
  try {
    const r = await client.callTool({
      name: "sql_query",
      arguments: { query: "SELECT id, from_agent, to_agent, channel, message_type, message_content FROM roadmap.message_ledger ORDER BY created_at DESC LIMIT 5" }
    });
    console.log(r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DEBUG: Test invalid channel 'invalid-channel' ===");
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from_agent: "debug-test-agent",
        message_content: "Invalid channel test",
        channel: "invalid-channel"
      }
    });
    console.log("Result (should be error):", r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error (expected):", e.message); }

  console.log("\n=== DEBUG: Test wrong param names ===");
  try {
    const r = await client.callTool({
      name: "msg_send",
      arguments: {
        from: "debug-test-agent",
        to: "debug-test-agent",
        message: "Wrong params"
      }
    });
    console.log("Result (should be error):", r.content?.[0]?.text || JSON.stringify(r));
  } catch (e) { console.log("Error (expected):", e.message); }

  await client.close();
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
