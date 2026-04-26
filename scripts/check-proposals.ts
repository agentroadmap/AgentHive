import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "hermes-proposal-checker", version: "1.0.0" });
  await client.connect(transport);

  // List proposals
  console.log("Checking proposals...");
  const result = await client.callTool({
    name: "prop_list",
    arguments: {}
  });
  
  const text = result.content?.[0]?.text || "";
  console.log("Proposals (first 2000 chars):");
  console.log(text.substring(0, 2000));
  
  await client.close();
}

main().catch(console.error);
