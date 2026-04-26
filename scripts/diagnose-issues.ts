import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";

const transport = new SSEClientTransport(new URL(getMcpUrl()));
const client = new Client({ name: "hermes-diagnose", version: "1.0.0" });
await client.connect(transport);

// 1. Check transition queue for details
console.log("=== TRANSITION QUEUE DETAILS ===");
const list = await client.callTool({ name: "prop_list", arguments: {} });
const text = mcpText(list);

// Find proposals in different states
const stateMap: Record<string, string[]> = {
  TRIAGE: [],
  FIX: [],
  DEPLOYED: [],
  DRAFT: [],
  REVIEW: [],
  DEVELOP: [],
  MERGE: [],
  COMPLETE: [],
};

for (const line of text.split("\n")) {
  for (const state of Object.keys(stateMap)) {
    if (line.includes(`status: ${state}`)) {
      const idMatch = line.match(/\[(P\d+)\]/);
      if (idMatch) {
        stateMap[state].push(idMatch[1]);
      }
    }
  }
}

// Show what should be in Discord notifications
console.log("\n=== PROPOSALS BY STATE (for better Discord messages) ===");
for (const [state, proposals] of Object.entries(stateMap)) {
  if (proposals.length > 0) {
    console.log(`${state}: ${proposals.join(", ")}`);
  }
}

// 2. Check board command
console.log("\n=== BOARD COMMAND CHECK ===");
const boardHelp = await client.callTool({ name: "prop_list", arguments: {} });
console.log("Board might be hanging because:");
console.log("  - Postgres connection timeout");
console.log("  - TUI rendering issue");
console.log("  - Missing data");

await client.close();
