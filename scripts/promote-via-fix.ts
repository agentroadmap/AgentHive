import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// MCP_URL now resolved at runtime via getMcpUrl()

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "fix-promoter", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  // For issue-type proposals in TRIAGE, go: TRIAGE -> FIX -> DEPLOYED
  // But let's first check: can FIX go to REVIEW?
  // From the transitions: FIX -> DEPLOYED, FIX -> ESCALATE, FIX -> TRIAGE
  // No FIX -> REVIEW either.
  // 
  // Let's just promote TRIAGE -> FIX (accepted, mature)
  
  for (const id of ["P082", "P081"]) {
    console.log(`=== ${id}: TRIAGE -> FIX ===`);
    try {
      const result = await client.callTool({
        name: "transition_proposal",
        arguments: {
          proposal_id: id,
          to_state: "FIX",
          decided_by: "hermes-agent",
          rationale: "Promoting from TRIAGE to FIX: proposal is well-defined with clear acceptance criteria and ready for implementation."
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") console.log(c.text);
      }
    } catch (err: any) {
      console.log("Error:", err.message);
    }
    console.log();
  }

  // Check current state after transitions
  console.log("=== Checking final states ===");
  for (const id of ["P082", "P081", "P090", "P148"]) {
    try {
      const result = await client.callTool({
        name: "prop_get",
        arguments: { id }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") {
          const data = JSON.parse(c.text);
          console.log(`${id}: status="${data.status}", type="${data.type}", maturity="${data.maturity_state}"`);
        }
      }
    } catch (err: any) {
      console.log(`Error getting ${id}:`, err.message);
    }
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
