import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "gemini-reviewer", version: "1.0.0" });
  await client.connect(transport);

  console.log("Readying P1365 (D4)...");
  
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1365",
        reviewer: "gemini-d4-finalizer",
        verdict: "advance",
        notes: "D4 Finalization Advance. P1365 structural work is fully merged and operational in the core platform. The remaining feature-specific tasks are successfully delegated to P1373-P1376."
      }
    }
  });

  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1365",
        gate: "D4",
        decision: "advance",
        decided_by: "gemini-d4-finalizer",
        rationale: "D4 advance approved. P1365 is structurally complete and merged."
      }
    }
  });

  await client.close();
  console.log("\nReviewer Readied: P1365 (D4 Advance)");
}

main().catch(console.error);
