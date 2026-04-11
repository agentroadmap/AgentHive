import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes-architect", version: "1.0.0" });
await client.connect(transport);

// List all proposals
const result = await client.callTool({
  name: "prop_list",
  arguments: {}
});
const text = result.content?.[0]?.text || "";
console.log("ALL PROPOSALS (first 3000):", text.substring(0, 3000));

await client.close();

