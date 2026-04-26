import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL(getMcpUrl()));
const client = new Client({ name: "migration-runner", version: "1.0.0" });
await client.connect(transport);

console.log("=== Running Migration 014: Token Efficiency Metrics ===\n");

// Check if tables exist by trying to log spending
const logResult = await client.callTool({
  name: "spending_log",
  arguments: {
    agent_identity: "test-agent",
    model_name: "xiaomi/mimo-v2-pro",
    cost_usd: "0.001",
    input_tokens: "100",
    output_tokens: "50",
    task_type: "migration-test"
  }
});
console.log("Spending log result:", logResult.content?.[0]?.text?.substring(0, 200));

// Check spending report
const report = await client.callTool({
  name: "spending_report",
  arguments: {}
});
console.log("\nSpending report:", report.content?.[0]?.text?.substring(0, 500));

await client.close();
console.log("\n=== Migration check complete ===");
