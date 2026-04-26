import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";

const transport = new SSEClientTransport(new URL(getMcpUrl()));
const client = new Client({ name: "hermes-fix", version: "1.0.0" });
await client.connect(transport);

// Get proposal details for transitions
const list = await client.callTool({ name: "prop_list", arguments: {} });
const text = mcpText(list);

// Show current state ordering issue
console.log("=== CURRENT OUTPUT (wrong order) ===");
const lines = text.split("\n");
const states = ["TRIAGE", "FIX", "DEPLOYED", "DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"];

for (const state of states) {
  const stateLines = lines.filter(l => l.includes(`status: ${state}`));
  if (stateLines.length > 0) {
    console.log(`\n${state}:`);
    for (const line of stateLines.slice(0, 3)) {
      console.log("  " + line);
    }
    if (stateLines.length > 3) console.log(`  ... and ${stateLines.length - 3} more`);
  }
}

// Show correct workflow order
console.log("\n=== CORRECT WORKFLOW ORDER ===");
console.log("RFC (feature/component/product): DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE");
console.log("Quick Fix (issue): TRIAGE → FIX → DEPLOYED");

await client.close();
