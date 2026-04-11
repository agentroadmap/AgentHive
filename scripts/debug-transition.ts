import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = "http://127.0.0.1:6421/sse";

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "debug-transition", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  // Re-check current status of P082 and P081
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
          console.log(`${id}: status="${data.status}", type="${data.type}", maturity="${data.maturity_state}"`);
        }
      }
    } catch (err: any) {
      console.log(`Error getting ${id}:`, err.message);
    }
  }

  // Try prop_update to set status to "REVIEW" (uppercase)
  console.log("\nTrying prop_update with status REVIEW...");
  for (const id of ["P082", "P081"]) {
    try {
      const result = await client.callTool({
        name: "prop_update",
        arguments: {
          id,
          status: "REVIEW"
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") console.log(`${id}: ${c.text}`);
      }
    } catch (err: any) {
      console.log(`${id} prop_update error:`, err.message);
    }
  }

  // Try prop_transition with different status casing
  console.log("\nTrying prop_transition with status 'Review'...");
  for (const id of ["P082", "P081"]) {
    try {
      const result = await client.callTool({
        name: "prop_transition",
        arguments: {
          id,
          status: "Review"
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") console.log(`${id}: ${c.text}`);
      }
    } catch (err: any) {
      console.log(`${id} prop_transition error:`, err.message);
    }
  }

  await client.close();
}

main().catch(console.error);
