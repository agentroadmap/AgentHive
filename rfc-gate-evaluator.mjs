import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = "http://127.0.0.1:6421/sse";

async function main() {
  console.log("=== RFC Gate Evaluator ===");
  console.log(`Connecting to MCP at ${MCP_URL}...`);

  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "rfc-gate-evaluator", version: "1.0.0" });

  try {
    await client.connect(transport);
    console.log("Connected successfully!\n");

    // List available tools
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name);
    console.log(`Available tools (${toolNames.length}):`);
    toolNames.forEach(n => console.log(`  - ${n}`));
    console.log();

    // Helper to call a tool
    async function callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content?.[0]?.text || JSON.stringify(result);
      return content;
    }

    // =====================================================
    // QUICK FIX WORKFLOW: TRIAGE → FIX → DEPLOYED
    // =====================================================
    console.log("\n" + "=".repeat(60));
    console.log("QUICK FIX WORKFLOW");
    console.log("=".repeat(60));

    // List TRIAGE issues
    console.log("\n--- Checking TRIAGE issues ---");
    let triageResult;
    try {
      triageResult = await callTool("proposal_list", { state: "triage", type: "issue" });
      console.log(`Triage issues:\n${triageResult}`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    // List FIX issues
    console.log("\n--- Checking FIX issues ---");
    let fixResult;
    try {
      fixResult = await callTool("proposal_list", { state: "fix", type: "issue" });
      console.log(`Fix issues:\n${fixResult}`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    // =====================================================
    // RFC WORKFLOW: DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE
    // =====================================================
    console.log("\n" + "=".repeat(60));
    console.log("RFC WORKFLOW");
    console.log("=".repeat(60));

    // List DRAFT proposals
    console.log("\n--- Checking DRAFT proposals ---");
    let draftResult;
    try {
      draftResult = await callTool("proposal_list", { state: "draft" });
      console.log(`Draft proposals:\n${draftResult}`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    // List REVIEW proposals
    console.log("\n--- Checking REVIEW proposals ---");
    let reviewResult;
    try {
      reviewResult = await callTool("proposal_list", { state: "review" });
      console.log(`Review proposals:\n${reviewResult}`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    // List DEVELOP proposals
    console.log("\n--- Checking DEVELOP proposals ---");
    let developResult;
    try {
      developResult = await callTool("proposal_list", { state: "develop" });
      console.log(`Develop proposals:\n${developResult}`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    // List MERGE proposals
    console.log("\n--- Checking MERGE proposals ---");
    let mergeResult;
    try {
      mergeResult = await callTool("proposal_list", { state: "merge" });
      console.log(`Merge proposals:\n${mergeResult}`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    await client.close();
    console.log("\n=== Evaluation complete ===");

  } catch (err) {
    console.error("MCP Error:", err.message);
    try { await client.close(); } catch {}
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
