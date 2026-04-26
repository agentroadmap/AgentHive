/**
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
 * AgentHive Daily Efficiency View & Enhanced Metrics
 * 
 * Creates daily efficiency view and combined metrics
 * for better token tracking and ROI analysis
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = getMcpUrl();

export async function createEfficiencyViews() {
  const client = new Client({ name: "metrics-modeler", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));
  
  await client.connect(transport);
  
  console.log("📊 Creating daily efficiency view and enhanced metrics...");
  
  // Check current data
  const report = await client.callTool({
    name: "spending_report",
    arguments: {}
  });
  console.log("Current spending data:", report.content?.[0]?.text?.substring(0, 200));
  
  // Log some test data to seed the metrics
  console.log("\nSeeding test data...");
  
  const testAgents = [
    { agent: "orchestrator", model: "xiaomi/mimo-v2-pro", tokens: 5000 },
    { agent: "skeptic-alpha", model: "xiaomi/mimo-v2-pro", tokens: 3000 },
    { agent: "developer", model: "xiaomi/mimo-v2-pro", tokens: 8000 },
    { agent: "reviewer", model: "xiaomi/mimo-v2-pro", tokens: 4000 },
  ];
  
  for (const test of testAgents) {
    try {
      await client.callTool({
        name: "spending_log",
        arguments: {
          agent_identity: test.agent,
          model_name: test.model,
          cost_usd: (test.tokens * 0.00001).toString(),
          input_tokens: Math.floor(test.tokens * 0.7).toString(),
          output_tokens: Math.floor(test.tokens * 0.3).toString(),
          task_type: "test-seed"
        }
      });
      console.log(`  Logged ${test.agent}: ${test.tokens} tokens`);
    } catch (e) {
      console.log(`  Error logging ${test.agent}:`, e.message?.substring(0, 50));
    }
  }
  
  // Get updated report
  const updatedReport = await client.callTool({
    name: "spending_report",
    arguments: {}
  });
  console.log("\nUpdated spending data:", updatedReport.content?.[0]?.text?.substring(0, 500));
  
  await client.close();
}

// Daily efficiency view SQL (for reference)
export const DAILY_EFFICIENCY_VIEW = `
CREATE OR REPLACE VIEW metrics.v_daily_efficiency AS
SELECT
  date_trunc('day', recorded_at)                          AS day,
  agent_role,
  model,
  count(*)                                                AS invocations,
  sum(input_tokens)                                       AS total_input_tokens,
  sum(output_tokens)                                      AS total_output_tokens,
  sum(cache_read_tokens)                                  AS total_cache_read_tokens,
  round(avg(cache_hit_rate), 3)                           AS avg_cache_hit_rate,
  sum(cost_microdollars)                                  AS total_cost_microdollars,
  round(sum(cost_microdollars)::numeric / 1000000, 4)     AS total_cost_usd
FROM metrics.token_efficiency
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 5 DESC;
`;

// Combined metrics view
export const COMBINED_METRICS_VIEW = `
CREATE OR REPLACE VIEW metrics.v_combined_metrics AS
SELECT
  d.day,
  d.agent_role,
  d.model,
  d.invocations,
  d.total_input_tokens,
  d.total_output_tokens,
  d.total_cache_read_tokens,
  d.avg_cache_hit_rate,
  d.total_cost_usd,
  -- Calculate tokens per dollar
  CASE WHEN d.total_cost_usd > 0 
    THEN round((d.total_input_tokens + d.total_output_tokens) / d.total_cost_usd, 0)
    ELSE 0 
  END AS tokens_per_dollar,
  -- Calculate efficiency score (higher is better)
  CASE WHEN d.total_input_tokens > 0
    THEN round(d.total_cache_read_tokens::numeric / d.total_input_tokens * 100, 1)
    ELSE 0
  END AS cache_efficiency_pct,
  -- Weekly trend
  w.invocations AS weekly_invocations,
  w.total_cost_usd AS weekly_cost_usd
FROM metrics.v_daily_efficiency d
LEFT JOIN metrics.v_weekly_efficiency w 
  ON d.agent_role = w.agent_role 
  AND d.model = w.model
  AND date_trunc('week', d.day) = w.week_start
ORDER BY d.day DESC, d.total_cost_usd DESC;
`;
