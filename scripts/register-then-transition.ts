import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = "http://127.0.0.1:6421/sse";

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "register-transition", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  // First register the agent
  console.log("Registering hermes-agent...");
  try {
    const result = await client.callTool({
      name: "agent_register",
      arguments: {
        identity: "hermes-agent",
        agent_type: "llm",
        status: "active"
      }
    });
    const content = result.content as any[];
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
    }
  } catch (err: any) {
    console.log("Error:", err.message);
  }

  // Now try the transitions again
  for (const id of ["P082", "P081"]) {
    console.log(`\n=== ${id}: TRIAGE -> FIX ===`);
    try {
      const result = await client.callTool({
        name: "transition_proposal",
        arguments: {
          proposal_id: id,
          to_state: "FIX",
          decided_by: "hermes-agent",
          rationale: "Well-defined proposal with clear ACs, ready for implementation."
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") console.log(c.text);
      }
    } catch (err: any) {
      console.log("Error:", err.message);
    }
  }

  // Check final states
  console.log("\n=== Final states ===");
  for (const id of ["P082", "P081"]) {
    try {
      const result = await client.callTool({
        name: "prop_get",
        arguments: { id }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") {
          const data = JSON.parse(c.text);
          console.log(`${id}: status="${data.status}"`);
        }
      }
    } catch (err: any) {
      console.log(`Error:`, err.message);
    }
  }

  await client.close();
}

main().catch(console.error);
