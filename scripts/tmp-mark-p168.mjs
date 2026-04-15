import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes", version: "1.0.0" });
await client.connect(transport);

// Mark P168 mature
const r = await client.callTool({ name: "prop_set_maturity", arguments: { proposal_id: "168", maturity: "mature" } });
console.log("P168:", r.content?.[0]?.text);

await client.close();
