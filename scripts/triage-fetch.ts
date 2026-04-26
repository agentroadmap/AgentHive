import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";

const PROPOSALS = [
  "P088", "P143", "P144", "P150", "P152", "P091", "P146",
  "P147", "P145", "P086", "P087", "P089", "P151"
];

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "triage-agent", version: "1.0.0" });
  await client.connect(transport);

  const results: Record<string, any> = {};

  for (const id of PROPOSALS) {
    try {
      const res = await client.callTool({ name: "prop_get", arguments: { id } });
      results[id] = res.content;
      // Extract text content
      const textBlock = (res.content as any[]).find((c: any) => c.type === "text");
      if (textBlock) {
        console.log(`\n=== ${id} ===`);
        console.log(textBlock.text);
      }
    } catch (err: any) {
      console.error(`ERROR fetching ${id}: ${err.message}`);
      results[id] = { error: err.message };
    }
  }

  await client.close();
}

main().catch(console.error);
