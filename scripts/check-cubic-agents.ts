import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes-check", version: "1.0.0" });
await client.connect(transport);

// List tools related to cubic and agents
const tools = await client.listTools();
const relevant = tools.tools.filter((t: any) => 
  t.name.includes("cubic") || 
  t.name.includes("agent") || 
  t.name.includes("spawn") ||
  t.name.includes("team")
);
console.log("=== CUBIC & AGENT TOOLS ===");
for (const t of relevant) {
  console.log(`- ${t.name}: ${t.description?.substring(0, 80)}`);
}

// Check cubic status
console.log("\n=== CUBIC LIST ===");
const cubes = await client.callTool({ name: "cubic_list", arguments: {} });
console.log(mcpText(cubes).substring(0, 1000));

// Check agent list
console.log("\n=== AGENT LIST ===");
const agents = await client.callTool({ name: "agent_list", arguments: {} });
console.log(mcpText(agents).substring(0, 1000));

await client.close();

