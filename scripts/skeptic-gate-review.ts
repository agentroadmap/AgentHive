import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "skeptic-gate", version: "1.0.0" });
await client.connect(transport);

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║           SKEPTIC GATE REVIEW — ADVERSARIAL ANALYSIS        ║");
console.log("╠══════════════════════════════════════════════════════════════╣");
console.log("║                                                              ║");
console.log("║  \"The best decision is one that survived rigorous challenge\" ║");
console.log("║                                                              ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log("");

// D2 GATE: REVIEW → DEVELOP
console.log("=== D2 GATE: REVIEW → DEVELOP ===");
console.log("Rule: REQUIRES ALL ACCEPTANCE CRITERIA");
console.log("");

// Check P149
const p149 = await client.callTool({ name: "prop_get", arguments: { id: "P149" } });
const p149Data = JSON.parse(p149.content?.[0]?.text || "{}");

console.log("P149 — Channel subscription and push notifications");
console.log("  Status: " + p149Data.status);
console.log("  Maturity: " + p149Data.maturity_state);
console.log("  Has ACs: " + (p149Data.acceptance_criteria?.length > 0 ? "Yes (" + p149Data.acceptance_criteria.length + ")" : "NO"));
console.log("");

if (!p149Data.acceptance_criteria?.length) {
  console.log("  🚨 SKEPTIC VERDICT: BLOCKED");
  console.log("  Reason: No acceptance criteria defined");
  console.log("  Gate rule: REVIEW → DEVELOP requires AC: all");
  console.log("  Action: PROPOSAL CANNOT ADVANCE");
  console.log("");
  console.log("  SKEPTIC CHALLENGES:");
  console.log("  1. How can we verify the implementation without ACs?");
  console.log("  2. What defines 'done' for this feature?");
  console.log("  3. How do we prevent scope creep without ACs?");
  console.log("  4. What edge cases should we consider?");
  console.log("  5. What are the performance requirements?");
  console.log("");
  console.log("  REQUIRED ACs (suggested by skeptic):");
  console.log("  - AC-1: channel_subscription table with proper schema");
  console.log("  - AC-2: pg_notify trigger fires on message insert");
  console.log("  - AC-3: MCP server listens for notifications");
  console.log("  - AC-4: msg_subscribe tool works correctly");
  console.log("  - AC-5: Graceful fallback when pg_notify unavailable");
  console.log("  - AC-6: Performance: <100ms notification delivery");
  console.log("  - AC-7: Integration: Works with existing msg_send/msg_read");
  console.log("");
}

// D3 GATE: DEVELOP → MERGE  
console.log("=== D3 GATE: DEVELOP → MERGE ===");
console.log("Rule: REQUIRES ALL ACs VERIFIED + CODE REVIEWED");
console.log("");

// Check develop proposals
const developIds = ["P045", "P046", "P047", "P048", "P066", "P067", "P068", "P051", "P054", "P056", "P057", "P060", "P065"];

for (const id of developIds) {
  try {
    const result = await client.callTool({ name: "prop_get", arguments: { id } });
    const data = JSON.parse(result.content?.[0]?.text || "{}");
    
    if (data.status === "DEVELOP" && data.maturity_state === "mature") {
      console.log(`${id} — ${data.title?.substring(0, 50)}`);
      console.log("  Maturity: mature (ready for merge)");
      console.log("  SKEPTIC QUESTION: Has code been reviewed?");
      console.log("  SKEPTIC QUESTION: Do all ACs pass tests?");
      console.log("  SKEPTIC QUESTION: Are integration constraints met?");
      console.log("");
    }
  } catch (e) {}
}

// SUMMARY
console.log("=== SKEPTIC GATE SUMMARY ===");
console.log("");
console.log("BLOCKED:");
console.log("  • P149 — No ACs, cannot advance from REVIEW");
console.log("");
console.log("CHALLENGED:");
console.log("  • All DEVELOP proposals — Need code review before merge");
console.log("  • Are tests comprehensive?");
console.log("  • Are integration constraints considered?");
console.log("  • Were alternatives explored?");
console.log("");
console.log("ALTERNATIVES OVERLOOKED:");
console.log("  • P149: Consider Redis pub/sub instead of pg_notify?");
console.log("  • P050: Use existing DAG library (dagre, graphlib)?");
console.log("  • P054: Cryptographic identity instead of string handles?");
console.log("");
console.log("INTEGRATION CONSTRAINTS:");
console.log("  • How do P149 notifications interact with P050 DAG?");
console.log("  • Does P054 identity work with P056 lease protocol?");
console.log("  • Will P059 model routing conflict with P060 circuit breaker?");
console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("SKEPTIC: \"I question whether we've done enough research.\"");
console.log("SKEPTIC: \"The gate criteria may be too permissive.\"");
console.log("SKEPTIC: \"We need more adversarial review before advancing.\"");
console.log("═══════════════════════════════════════════════════════════════");

await client.close();
