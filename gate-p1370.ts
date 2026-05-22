import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "gemini-reviewer", version: "1.0.0" });
  await client.connect(transport);

  console.log("Readying P1370 (D2)...");
  // 1. Submit D2 Review for P1370
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "submit_review",
      args: {
        proposal_id: "P1370",
        reviewer: "gemini-architecture-reviewer",
        verdict: "advance",
        notes: "D2 Architecture Advance. Remediation verified: fixed provider_health join column (provider_name), corrected dispatch_status list, added paused_roles to view, and clarified async background refresh for stale data. Dependency on P1365 merge is explicitly gated in AC-10 and the migration DDL."
      }
    }
  });

  // 2. Gate Decision D2 for P1370
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "gate_decision",
      args: {
        proposal_id: "P1370",
        gate: "D2",
        decision: "advance",
        decided_by: "gemini-architecture-reviewer",
        rationale: "D2 advance approved. Blockers from reality-checker review have been addressed in the design and ACs. Architecture is sound and respects system-wide dependencies."
      }
    }
  });

  await client.close();
  console.log("\nReviewer Readied: P1370 (D2 Advance)");
}

main().catch(console.error);
