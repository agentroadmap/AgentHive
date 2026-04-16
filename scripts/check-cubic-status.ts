import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes-check", version: "1.0.0" });
await client.connect(transport);

// Get all cubics
const cubes = await client.callTool({ name: "cubic_list", arguments: {} });
const text = mcpText(cubes);
const data = JSON.parse(text);
const cubics = data.cubics || [];

// Group by phase
const phases: Record<string, any[]> = {};
for (const c of cubics) {
  if (!phases[c.phase]) phases[c.phase] = [];
  phases[c.phase].push(c);
}

console.log("=== CUBICS BY PHASE ===");
for (const [phase, list] of Object.entries(phases)) {
  console.log(`${phase}: ${list.length} cubics`);
}

// Show non-complete cubics (active work)
console.log("\n=== ACTIVE CUBICS ===");
const active = cubics.filter((c: any) => c.phase !== "complete");
for (const c of active.slice(0, 10)) {
  console.log(`- ${c.id}: "${c.name}" phase:${c.phase} gate:${c.phaseGate} proposals:${c.assignedProposals?.length || 0}`);
}

// Show agent roster
console.log("\n=== AGENT ROSTER ===");
const agents = await client.callTool({ name: "agent_list", arguments: {} });
console.log(mcpText(agents).substring(0, 800));

await client.close();

