import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = getMcpUrl();
const PROPOSALS = ["P082", "P090", "P148", "P081"];

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "draft-enhancer", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  // Fetch each proposal
  for (const id of PROPOSALS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Fetching proposal ${id}...`);
    try {
      const result = await client.callTool({ name: "prop_get", arguments: { id } });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") {
          console.log(c.text);
        }
      }
    } catch (err: any) {
      console.error(`Error fetching ${id}:`, err.message);
    }
  }

  await client.close();
}

main().catch(console.error);
