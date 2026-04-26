import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";

type Cubic = {
	id: string;
	name?: string;
	phase?: string;
	lock?: unknown;
};

type CubicList = {
	total?: number;
	cubics: Cubic[];
};

const transport = new SSEClientTransport(new URL(getMcpUrl()));
const client = new Client({ name: "hermes", version: "1.0.0" });
await client.connect(transport);

// List all cubics
const list = await client.callTool({ name: "cubic_list", arguments: {} });
const data = parseMcpJson<CubicList>(list, { cubics: [] });

console.log("Total cubics: " + data.total);

// Categorize
const active = data.cubics.filter((c) => c.lock);
const complete = data.cubics.filter((c) => c.phase === "complete");
const design = data.cubics.filter((c) => c.phase === "design" && !c.lock);
const other = data.cubics.filter((c) => !c.lock && c.phase !== "complete" && c.phase !== "design");

console.log("Active (locked): " + active.length);
console.log("Complete: " + complete.length);
console.log("Idle design: " + design.length);
console.log("Other idle: " + other.length);

// Delete complete cubics
console.log("\n=== DELETING COMPLETE CUBICS ===");
let deleted = 0;
for (const c of complete) {
  try {
    // Use cubic_recycle with resetCode to clean up
    await client.callTool({
      name: "cubic_recycle",
      arguments: { cubicId: c.id, resetCode: true }
    });
    deleted++;
    if (deleted <= 5) {
      console.log("  Deleted: " + c.id);
    }
  } catch (e) {
    // Ignore errors
  }
}
console.log("  ... deleted " + deleted + " complete cubics");

// Delete idle design cubics (stale)
console.log("\n=== DELETING STALE DESIGN CUBICS ===");
let staleDeleted = 0;
for (const c of design) {
  try {
    await client.callTool({
      name: "cubic_recycle",
      arguments: { cubicId: c.id, resetCode: true }
    });
    staleDeleted++;
    if (staleDeleted <= 5) {
      console.log("  Deleted: " + c.id + " - " + c.name?.substring(0, 40));
    }
  } catch (e) {
    // Ignore errors
  }
}
console.log("  ... deleted " + staleDeleted + " stale cubics");

// Final count
const finalList = await client.callTool({ name: "cubic_list", arguments: {} });
const finalData = parseMcpJson<CubicList>(finalList, { cubics: [] });
console.log("\n=== FINAL STATUS ===");
console.log("Remaining cubics: " + finalData.total);
console.log("Active (locked): " + finalData.cubics.filter((c) => c.lock).length);

await client.close();
