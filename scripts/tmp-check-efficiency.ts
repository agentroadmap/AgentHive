import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes", version: "1.0.0" });
await client.connect(transport);

// Get details of key efficiency proposals
const ids = ["P059", "P090", "P164", "P189", "P194"];
for (const id of ids) {
  const r = await client.callTool({ name: "prop_get", arguments: { id } });
  const text = r.content?.[0]?.text || "";
  const first200 = text.substring(0, 200).replace(/\n/g, " ");
  console.log(`${id}: ${first200}`);
  
  // Get ACs
  const ac = await client.callTool({ name: "list_ac", arguments: { proposal_id: id } });
  const acText = ac.content?.[0]?.text || "";
  const passCount = (acText.match(/pass/gi) || []).length;
  const totalCount = (acText.match(/AC-\d+/g) || []).length;
  const pendingCount = (acText.match(/pending/gi) || []).length;
  console.log(`  ACs: ${totalCount} total, ${passCount} pass, ${pendingCount} pending`);
  console.log("");
}

await client.close();
