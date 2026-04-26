import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// MCP_URL now resolved at runtime via getMcpUrl()

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "promote-with-reason", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  // Try prop_transition with reason "submit" (as shown in valid transitions)
  const proposals = [
    { id: "P082", notes: "DAG cycle detection fix is well-scoped and mature. Design has clear root cause analysis, 4-phase fix plan, and leverages existing DAGHealth.wouldCreateCycle() infrastructure." },
    { id: "P081", notes: "SLA contract proposal is well-defined with specific measurable targets. Standalone document approach is appropriate." },
  ];

  for (const p of proposals) {
    console.log(`=== Promoting ${p.id} ===`);
    
    // Try with reason "submit"
    console.log("Trying reason=submit...");
    try {
      const result = await client.callTool({
        name: "prop_transition",
        arguments: {
          id: p.id,
          status: "Review",
          reason: "submit",
          notes: p.notes,
          author: "hermes-agent"
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") console.log(c.text);
      }
    } catch (err: any) {
      console.log("Error:", err.message);
    }

    // Also try transition_proposal (the RFC tool)
    console.log("Trying transition_proposal...");
    try {
      const result = await client.callTool({
        name: "transition_proposal",
        arguments: {
          proposal_id: p.id,
          to_state: "Review",
          decided_by: "hermes-agent",
          rationale: p.notes
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

  await client.close();
  console.log("Done.");
}

main().catch(console.error);
