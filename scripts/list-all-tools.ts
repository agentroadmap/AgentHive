import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "hermes-tool-lister", version: "1.0.0" });
  await client.connect(transport);

  // List all tools
  console.log("=== All Available Tools ===");
  const tools = await client.listTools();
  
  console.log(`\nTotal tools: ${tools.tools.length}\n`);
  
  // Group by category
  const categories: Record<string, string[]> = {};
  
  for (const tool of tools.tools) {
    const category = tool.name.split('_')[0] || 'other';
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(tool.name);
  }
  
  // Print by category
  for (const [category, toolNames] of Object.entries(categories).sort()) {
    console.log(`\n${category.toUpperCase()} (${toolNames.length}):`);
    for (const name of toolNames.sort()) {
      console.log(`  - ${name}`);
    }
  }
  
  await client.close();
}

main().catch(console.error);
