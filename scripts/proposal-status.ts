import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "hermes-proposal-status", version: "1.0.0" });
  await client.connect(transport);

  // List all proposals
  console.log("Getting all proposals...");
  const result = await client.callTool({
    name: "prop_list",
    arguments: {}
  });
  
  const text = result.content?.[0]?.text || "";
  
  // Count by status
  const statusCounts: Record<string, number> = {};
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (line.includes('status:')) {
      const statusMatch = line.match(/status:\s*(\w+)/);
      if (statusMatch) {
        const status = statusMatch[1];
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      }
    }
  }
  
  console.log("\nProposal Status Distribution:");
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status}: ${count}`);
  }
  
  // Show non-complete proposals
  console.log("\nNon-Complete Proposals:");
  for (const line of lines) {
    if (line.includes('status:') && !line.includes('COMPLETE') && !line.includes('Complete')) {
      console.log(`  ${line.substring(0, 150)}`);
    }
  }
  
  await client.close();
}

main().catch(console.error);
