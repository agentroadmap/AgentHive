import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "gemini-reviewer", version: "1.0.0" });
  await client.connect(transport);

  console.log("Readying P1365 (D1)...");
  
  // Submit D1 Review for P1365
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1365",
        reviewer: "gemini-d1-readiness",
        verdict: "advance",
        notes: "D1 Readiness Advance. Proposal design is sound, ACs are registered, and the architectural separation between the capacity tracker and resolver routing is correct. The operator has confirmed the migration has been successfully applied to the live database, and follow-up work has been correctly chunked into children P1373-P1376."
      }
    }
  });

  // Gate Decision D1 for P1365
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1365",
        gate: "D1",
        decision: "advance",
        decided_by: "gemini-d1-readiness",
        rationale: "D1 advance approved. Architecture is well-scoped, the table schema has been verified live, and test suite is passing."
      }
    }
  });

  await client.close();
  console.log("\nReviewer Readied: P1365 (D1 Advance)");
}

main().catch(console.error);
