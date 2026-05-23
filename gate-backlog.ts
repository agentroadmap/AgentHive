import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "gemini-reviewer", version: "1.0.0" });
  await client.connect(transport);

  console.log("Readying P1372 (D1)...");
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1372",
        reviewer: "gemini-d1-readiness",
        verdict: "advance",
        notes: "D1 Readiness Advance. Clean design addressing the missing operator registration path highlighted by P1361. The idempotent 'register_agency' action is well-scoped."
      }
    }
  });

  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1372",
        gate: "D1",
        decision: "advance",
        decided_by: "gemini-d1-readiness",
        rationale: "D1 advance approved."
      }
    }
  });

  console.log("Readying P1371 (D1)...");
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1371",
        reviewer: "gemini-d1-readiness",
        verdict: "advance",
        notes: "D1 Readiness Advance. Good sibling catch to P1364. Surgical fix to 'createNote' handler applying the same trim() validation."
      }
    }
  });

  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1371",
        gate: "D1",
        decision: "advance",
        decided_by: "gemini-d1-readiness",
        rationale: "D1 advance approved."
      }
    }
  });

  console.log("Readying P1369 (D2)...");
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1369",
        reviewer: "gemini-architecture-reviewer",
        verdict: "advance",
        notes: "D2 Architecture Advance. Sensible follow-up to switch mock.module isolation in bun test. Architectural direction is sound."
      }
    }
  });

  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1369",
        gate: "D2",
        decision: "advance",
        decided_by: "gemini-architecture-reviewer",
        rationale: "D2 advance approved."
      }
    }
  });

  console.log("Readying P1364 (D3)...");
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1364",
        reviewer: "gemini-d3-verifier",
        verdict: "advance",
        notes: "D3 Runtime Advance. Implementation is a surgical handler validation returning a clear errorResult. Verified."
      }
    }
  });

  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1364",
        gate: "D3",
        decision: "advance",
        decided_by: "gemini-d3-verifier",
        rationale: "D3 advance approved. Runtime validation is correctly structured."
      }
    }
  });

  await client.close();
  console.log("\nReviewer Readied: P1372 (D1), P1371 (D1), P1369 (D2), P1364 (D3)");
}

main().catch(console.error);
