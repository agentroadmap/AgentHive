import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "migration-runner", version: "1.0.0" });
await client.connect(transport);

console.log("=== Creating metrics and token_cache schemas ===");

// We can't run DDL directly through MCP, but we can check if tables exist
// by trying to use the spending_log tool

const report = await client.callTool({
  name: "spending_report",
  arguments: {}
});
console.log("Current spending report:", report.content?.[0]?.text);

// Try to get knowledge stats
const stats = await client.callTool({
  name: "knowledge_get_stats",
  arguments: {}
});
console.log("\nKnowledge stats:", stats.content?.[0]?.text?.substring(0, 300));

// Check memory
const mem = await client.callTool({
  name: "memory_list",
  arguments: {}
});
console.log("\nMemory:", mem.content?.[0]?.text?.substring(0, 300));

await client.close();
console.log("\n=== Done ===");
