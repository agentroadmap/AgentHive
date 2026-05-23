import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "gemini-reviewer", version: "1.0.0" });
  await client.connect(transport);

  console.log("Readying P1367 (D1)...");
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1367",
        reviewer: "gemini-d1-readiness",
        verdict: "advance",
        notes: "D1 Readiness Advance. The P996 amendment design is clear, additive, and addresses the operator's request for alias variants (e.g. claude-mimo-a). Resolves ambiguity in previous dotted syntax."
      }
    }
  });

  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1367",
        gate: "D1",
        decision: "advance",
        decided_by: "gemini-d1-readiness",
        rationale: "D1 advance approved. Clean schema amendment."
      }
    }
  });
  
  await client.close();
  console.log("\nReviewer Readied: P1367 (D1 Advance)");
}

main().catch(console.error);
