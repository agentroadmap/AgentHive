import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "skeptic-agent", version: "1.0.0" });
await client.connect(transport);

console.log("=== SKEPTIC AGENT — Adversarial Review ===\n");

// Create skeptic cubic
const cubic = await client.callTool({
  name: "cubic_create",
  arguments: {
    name: "Skeptic — Adversarial Review",
    agents: ["skeptic", "auditor"],
    proposals: ["P149", "P050", "P054", "P059", "P061", "P062"]
  }
});
console.log("Skeptic cubic created:", mcpText(cubic).substring(0, 150));

// Focus the cubic
const focus = await client.callTool({
  name: "cubic_focus",
  arguments: {
    cubicId: "cubic-904830",
    agent: "skeptic",
    task: "Challenge gate decisions and question design choices. Look for: inadequate research, missing integration constraints, overlooked alternatives, weak acceptance criteria.",
    phase: "design"
  }
});
console.log("\nCubic focused:", mcpText(focus).substring(0, 100));

// Review recent gate decisions
console.log("\n=== SKEPTIC REVIEW — Questioning Recent Decisions ===\n");

// Check P149 — was it advanced too quickly?
const p149 = await client.callTool({
  name: "prop_get",
  arguments: { id: "P149" }
});
const p149Data = JSON.parse(mcpText(p149) || "{}");
console.log("P149 Challenge:");
console.log("  Status:", p149Data.status);
console.log("  Has ACs:", p149Data.acceptance_criteria?.length > 0 ? "Yes" : "NO — BLOCKED");
console.log("  Question: Can P149 advance without ACs? No — gate requires AC: all");
console.log("  Action: BLOCKED until ACs are added\n");

// Check if develop proposals were advanced without proper review
console.log("=== SKEPTIC QUESTIONS ===\n");
console.log("1. Were proposals advanced too quickly from REVIEW to DEVELOP?");
console.log("   - Did each proposal have ALL acceptance criteria verified?");
console.log("   - Were integration constraints considered?");
console.log("   - Were alternatives explored?\n");

console.log("2. Are the acceptance criteria adequate?");
console.log("   - Do they cover edge cases?");
console.log("   - Are they measurable and testable?");
console.log("   - Do they consider failure modes?\n");

console.log("3. Are there overlooked alternatives?");
console.log("   - P050 (DAG Engine): Could we use existing DAG libraries?");
console.log("   - P054 (Agent Identity): Is string-based identity sufficient?");
console.log("   - P059 (Model Registry): Is the cost-aware routing correct?\n");

console.log("4. Integration constraints being missed?");
console.log("   - How do these proposals interact?");
console.log("   - Are there circular dependencies?");
console.log("   - Will they work together in production?\n");

// Add skeptic challenges to proposals
console.log("=== Adding Skeptic Challenges ===\n");

const challenges = [
  {
    id: "P149",
    challenge: "SKEPTIC: P149 has no acceptance criteria. It cannot advance from REVIEW without ACs. The design assumes pg_notify will work but doesn't address: (1) what happens if pg_notify fails mid-message? (2) how are subscription conflicts resolved? (3) what's the fallback for network partitions?"
  },
  {
    id: "P050",
    challenge: "SKEPTIC: P050 (DAG Engine) was advanced to DEVELOP but the implementation may not consider: (1) concurrent DAG modifications, (2) distributed graph updates, (3) performance with 1000+ proposals. Did we explore existing solutions like Neo4j or Redis Graph?"
  },
  {
    id: "P054",
    challenge: "SKEPTIC: P054 (Agent Identity) uses string-based identity. This is fragile. What about: (1) cryptographic identity verification? (2) key rotation? (3) cross-instance identity federation? The current design doesn't address impersonation risk."
  }
];

for (const c of challenges) {
  console.log(`${c.id}:`);
  console.log(`  ${c.challenge.substring(0, 120)}...`);
  console.log(`  Action: Log as issue proposal if not addressed\n`);
}

await client.close();
console.log("=== SKEPTIC AGENT READY ===");
console.log("The skeptic will challenge decisions and prevent groupthink.");
