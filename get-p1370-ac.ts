import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "ac-checker", version: "1.0.0" });
  await client.connect(transport);

  try {
    const result = await client.callTool({ name: "mcp_proposal", arguments: { action: "list_ac", args: { proposal_id: "P1370" } } });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
  }

  await client.close();
}

main().catch(console.error);
