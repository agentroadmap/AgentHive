import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes", version: "1.0.0" });
await client.connect(transport);

// Create a cubic for P047
const cubicResult = await client.callTool({
  name: "cubic_create",
  arguments: {
    name: "p047-efficiency-pillar",
    agents: ["developer"],
    proposals: ["47"],
  },
});
console.log("Cubic created:", cubicResult.content?.[0]?.text?.substring(0, 200));

const data = JSON.parse(cubicResult.content?.[0]?.text || "{}");
if (data.success && data.cubic?.id) {
  // Focus the cubic
  const focusResult = await client.callTool({
    name: "cubic_focus",
    arguments: {
      cubicId: data.cubic.id,
      agent: "developer",
      task: "Implement ACs for P047: Pillar 3 - Efficiency, Context & Financial Governance. Work through the 15 pending acceptance criteria systematically. Start with the first 5 ACs.",
      phase: "build",
    },
  });
  console.log("Focused:", focusResult.content?.[0]?.text?.substring(0, 200));
}

await client.close();
console.log("Done");
