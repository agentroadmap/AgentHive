import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes-fix", version: "1.0.0" });
await client.connect(transport);

// 1. Get all proposals and organize by type then workflow order
const list = await client.callTool({ name: "prop_list", arguments: {} });
const text = mcpText(list);
const lines = text.split("\n");

// Define workflow order per type
const RFC_ORDER = ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"];
const QUICK_FIX_ORDER = ["TRIAGE", "FIX", "DEPLOYED", "ESCALATE", "WONT_FIX"];

// Parse proposals
interface Proposal {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: string;
}

const proposals: Proposal[] = [];
for (const line of lines) {
  const idMatch = line.match(/\[(P\d+)\]/);
  const typeMatch = line.match(/type: (\w+)/);
  const statusMatch = line.match(/status: (\w+)/);
  const priorityMatch = line.match(/\[(HIGH|MEDIUM|LOW|CRITICAL)\]/);
  
  if (idMatch && typeMatch && statusMatch) {
    proposals.push({
      id: idMatch[1],
      title: line.split("]")[1]?.split("—")[0]?.trim() || "",
      type: typeMatch[1],
      status: statusMatch[1],
      priority: priorityMatch?.[1] || "NONE",
    });
  }
}

// Group by type
const byType: Record<string, Proposal[]> = {};
for (const p of proposals) {
  if (!byType[p.type]) byType[p.type] = [];
  byType[p.type].push(p);
}

// Define workflow order for each type
const TYPE_WORKFLOW: Record<string, string[]> = {
  feature: RFC_ORDER,
  component: RFC_ORDER,
  product: RFC_ORDER,
  issue: QUICK_FIX_ORDER,
};

// Sort and display
console.log("=== PROPOSALS BY TYPE AND WORKFLOW ORDER ===\n");

for (const [type, typeProposals] of Object.entries(byType)) {
  const workflow = TYPE_WORKFLOW[type] || RFC_ORDER;
  
  console.log(`=== ${type.toUpperCase()} (${typeProposals.length} proposals) ===`);
  console.log(`Workflow: ${workflow.join(" → ")}\n`);
  
  // Group by status in workflow order
  for (const status of workflow) {
    const inStatus = typeProposals.filter(p => p.status === status);
    if (inStatus.length > 0) {
      console.log(`${status}:`);
      for (const p of inStatus) {
        console.log(`  [${p.priority}] ${p.id} - ${p.title}`);
      }
      console.log("");
    }
  }
  
  // Show any proposals with unexpected status
  const unexpected = typeProposals.filter(p => !workflow.includes(p.status));
  if (unexpected.length > 0) {
    console.log("⚠️ UNEXPECTED STATUS:");
    for (const p of unexpected) {
      console.log(`  ${p.id} - ${p.title} (${p.status})`);
    }
    console.log("");
  }
}

// Show summary
console.log("=== SUMMARY ===");
for (const [status, count] of Object.entries(
  proposals.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>)
)) {
  console.log(`${status}: ${count}`);
}

await client.close();
