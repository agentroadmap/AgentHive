import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const ids = ["178", "179", "180", "183", "184", "185", "199"];

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "skeptic-alpha", version: "1.0.0" });
  await client.connect(transport);
  
  for (const id of ids) {
    try {
      const r = await client.callTool({ name: "prop_get", arguments: { id } });
      const text = r.content?.[0]?.text || "EMPTY";
      console.log(`\n${"=".repeat(80)}`);
      console.log(`P${id}:`);
      console.log(`${"=".repeat(80)}`);
      console.log(text.substring(0, 2000));
    } catch (e) {
      console.log(`P${id} ERROR: ${e.message}`);
    }
  }
  
  await client.close();
}

main().catch(console.error);
