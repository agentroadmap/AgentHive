import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL(getMcpUrl()));
  const client = new Client({ name: "hermes-message-checker", version: "1.0.0" });
  await client.connect(transport);

  // Check messages for various agents
  const agents = ["claude/andy", "claude/one", "codex/andy", "xiaomi", "system-monitor"];
  
  console.log("=== Checking Messages for All Agents ===");
  
  for (const agent of agents) {
    try {
      const result = await client.callTool({
        name: "msg_read",
        arguments: {
          agent: agent,
          limit: 10
        }
      });
      
      const text = result.content?.[0]?.text || "";
      if (text && !text.includes("No messages")) {
        console.log(`\n${agent}:`);
        console.log(text.substring(0, 500));
      }
    } catch (error) {
      console.log(`Error reading messages for ${agent}:`, error);
    }
  }
  
  await client.close();
}

main().catch(console.error);
