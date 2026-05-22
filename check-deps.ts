import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "status-checker", version: "1.0.0" });
  await client.connect(transport);

  for (const id of ["P1365", "P1367"]) {
    try {
      const result = await client.callTool({ name: "prop_get", arguments: { id } });
      console.log(`\nProposal ${id}:`);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error getting ${id}:`, err.message);
    }
  }

  await client.close();
}

main().catch(console.error);
