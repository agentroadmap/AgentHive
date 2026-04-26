import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = getMcpUrl();

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "draft-promoter-v2", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  // First, check valid transitions for P082 (issue type)
  console.log("=== Checking valid transitions for P082 ===");
  try {
    const result = await client.callTool({
      name: "get_valid_transitions",
      arguments: { proposal_id: "P082" }
    });
    const content = result.content as any[];
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
    }
  } catch (err: any) {
    console.log("Error:", err.message);
  }

  // Check valid transitions for P081
  console.log("\n=== Checking valid transitions for P081 ===");
  try {
    const result = await client.callTool({
      name: "get_valid_transitions",
      arguments: { proposal_id: "P081" }
    });
    const content = result.content as any[];
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
    }
  } catch (err: any) {
    console.log("Error:", err.message);
  }

  // Check valid transitions for P090
  console.log("\n=== Checking valid transitions for P090 ===");
  try {
    const result = await client.callTool({
      name: "get_valid_transitions",
      arguments: { proposal_id: "P090" }
    });
    const content = result.content as any[];
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
    }
  } catch (err: any) {
    console.log("Error:", err.message);
  }

  await client.close();
}

main().catch(console.error);
