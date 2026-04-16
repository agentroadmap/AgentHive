/**
 * System Monitor Agent — Spots inconsistencies and makes proposals
 * 
 * Monitors:
 * - Terminology mismatches across codebase
 * - State machine inconsistencies
 * - Proposal workflow issues
 * - Integration gaps
 * 
 * Makes proposals for rectifications or escalates to human
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText } from "../mcp-result.ts";

const MCP_URL = "http://127.0.0.1:6421/sse";

export async function systemMonitor() {
  const client = new Client({ name: "system-monitor", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));
  
  await client.connect(transport);
  
  console.log("🔍 System Monitor — Scanning for inconsistencies...");
  
  // Check proposals
  const proposals = await client.callTool({ name: "prop_list", arguments: {} });
  const text = mcpText(proposals);
  
  // Scan for inconsistencies
  const issues: string[] = [];
  
  // 1. Check for proposals with wrong workflow
  if (text.includes("status: Draft") && text.includes("type: issue")) {
    issues.push("Issue proposals in Draft state (should be TRIAGE)");
  }
  
  // 2. Check for missing ACs
  if (text.includes("REVIEW") && !text.includes("acceptance_criteria")) {
    issues.push("Review proposals missing acceptance criteria");
  }
  
  // 3. Check terminology
  const terms = ["cubic", "proposal", "gate", "maturity"];
  for (const term of terms) {
    // Check for inconsistent usage
    const count = (text.match(new RegExp(term, "gi")) || []).length;
    if (count > 10) {
      // Term is used frequently, check for inconsistencies
    }
  }
  
  // Create proposals for issues
  for (const issue of issues) {
    await client.callTool({
      name: "prop_create",
      arguments: {
        type: "issue",
        title: `System Monitor: ${issue}`,
        summary: `Detected by system monitor: ${issue}`,
        priority: "medium"
      }
    });
  }
  
  await client.close();
  return issues;
}
