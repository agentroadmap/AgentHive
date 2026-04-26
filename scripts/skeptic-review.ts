import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL(getMcpUrl()));
const client = new Client({ name: "skeptic-alpha", version: "1.0.0" });
await client.connect(transport);

const reviewIds = ["178", "179", "180", "183", "184", "185", "199"];

for (const id of reviewIds) {
  try {
    const r = await client.callTool({ name: "prop_get", arguments: { id } });
    console.log(`=== P${id} ===`);
    console.log(r.content?.[0]?.text?.substring(0, 3000));
    console.log();
  } catch (e) {
    console.log(`P${id} error: ${e}`);
  }

  try {
    const r = await client.callTool({ name: "list_ac", arguments: { proposal_id: id } });
    console.log(`--- ACs for P${id} ---`);
    console.log(r.content?.[0]?.text?.substring(0, 500));
    console.log();
  } catch (e) {
    console.log(`P${id} AC error: ${e}`);
  }

  try {
    const r = await client.callTool({ name: "get_dependencies", arguments: { fromProposalId: id } });
    console.log(`--- Deps for P${id} ---`);
    console.log(r.content?.[0]?.text?.substring(0, 500));
    console.log();
  } catch (e) {
    console.log(`P${id} deps error: ${e}`);
  }

  try {
    const r = await client.callTool({ name: "list_reviews", arguments: { proposal_id: id } });
    console.log(`--- Reviews for P${id} ---`);
    console.log(r.content?.[0]?.text?.substring(0, 500));
    console.log();
  } catch (e) {
    console.log(`P${id} reviews error: ${e}`);
  }
}

await client.close();
