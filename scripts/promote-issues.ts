import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = "http://127.0.0.1:6421/sse";

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "issue-promoter", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  // Promote P082 to Review with decision notes
  console.log("=== Promoting P082 ===");
  try {
    const result = await client.callTool({
      name: "prop_transition",
      arguments: {
        id: "P082",
        status: "Review",
        summary: "DAG cycle detection fix is well-scoped and mature. The design has clear root cause analysis, a 4-phase fix plan (application guard, DB trigger, data fix, integration tests), and leverages existing DAGHealth.wouldCreateCycle() infrastructure. Ready for review."
      }
    });
    const content = result.content as any[];
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
    }
  } catch (err: any) {
    console.log("Error:", err.message);
  }

  // Promote P081 to Review with decision notes
  console.log("\n=== Promoting P081 ===");
  try {
    const result = await client.callTool({
      name: "prop_transition",
      arguments: {
        id: "P081",
        status: "Review",
        summary: "SLA contract proposal is well-defined with specific measurable targets (p99 latency, availability, RTO, lease TTL, degraded state triggers). Standalone document approach is appropriate. Integration points with P063 Observability and P065 MCP Server are clear. Ready for review."
      }
    });
    const content = result.content as any[];
    for (const c of content) {
      if (c.type === "text") console.log(c.text);
    }
  } catch (err: any) {
    console.log("Error:", err.message);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch(console.error);
