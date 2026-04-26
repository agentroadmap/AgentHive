import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "hermes-tool-lister", version: "1.0.0" });
  await client.connect(transport);

  // List all tools
  console.log("=== Available MCP Tools ===");
  const tools = await client.listTools();
  
  const messageTools = tools.tools.filter(t => 
    t.name.includes('msg') || t.name.includes('message') || t.name.includes('chan')
  );
  
  console.log("\nMessage-related tools:");
  for (const tool of messageTools) {
    console.log(`  - ${tool.name}: ${tool.description?.substring(0, 100)}`);
  }
  
  console.log(`\nTotal tools: ${tools.tools.length}`);
  
  await client.close();
}

main().catch(console.error);
