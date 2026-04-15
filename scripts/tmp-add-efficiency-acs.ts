import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes", version: "1.0.0" });
await client.connect(transport);

// Add ACs to P229 (Platform Registry)
const p229acs = [
  "platform_registry table exists with all 6 providers (claude, codex, copilot, nous, openrouter, xiaomi) with auth_method, quota tracking, and health status",
  "model_catalog table has at least 10 models with cost_per_1k_input, cost_per_1k_output, capability_tier, max_context_tokens, and speed",
  "Orchestrator dispatchAgent includes model selection: task difficulty metadata maps to recommended model via routing rules",
  "Gate task templates include difficulty hint (easy/medium/hard) that influences model selection in spawn metadata",
  "MCP tool model_route(task_description, difficulty) returns ranked list of (model, provider) pairs",
  "Usage ledger tracks every agent_run with input_tokens, output_tokens, cost_usd, model_name, provider, task_type",
  "Dashboard or MCP tool shows: providers online, quota remaining, cost per day, cost per proposal"
];
const r1 = await client.callTool({ name: "add_acceptance_criteria", arguments: { proposal_id: "229", criteria: p229acs } });
console.log("P229 ACs:", r1.content?.[0]?.text?.substring(0, 80));

// Add ACs to P230 (Memory System)
const p230acs = [
  "team_memory table exists with CRUD MCP tools (team_mem_set, team_mem_get, team_mem_list) scoped by team_name",
  "agent_memory table exists with per-agent key-value store, importance scoring, and TTL-based decay",
  "context_packages table caches assembled context for proposals, invalidated on state change",
  "Gate agent dispatch includes constructed context package in task prompt (proposal + ACs + recent decisions + conventions)",
  "Team memory is queryable by agents in the same squad via MCP tool",
  "Agent memory persists preferences across sessions (e.g., output format, verbosity level)",
  "Context packages automatically invalidated when proposal status, AC status, or gate decision changes"
];
const r2 = await client.callTool({ name: "add_acceptance_criteria", arguments: { proposal_id: "230", criteria: p230acs } });
console.log("P230 ACs:", r2.content?.[0]?.text?.substring(0, 80));

// Add ACs to P231 (Token Efficiency)
const p231acs = [
  "Context construction function builds targeted context (< 2000 tokens) for any proposal + task type combination",
  "Gate agent dispatch uses constructed context instead of raw CLAUDE.md dump — measured token reduction >40%",
  "query_cache table exists and MCP tools check cache before making repeated DB queries",
  "Semantic cache from P090 is populated on first read and served from cache on subsequent reads for same content",
  "Anti-drift monitor checks agent stdout every 5 iterations, flags drift if output relevance drops below threshold",
  "Token count per agent_run tracked in usage_ledger with input_tokens, output_tokens, and cost_usd",
  "Shared context between agents via team_memory — agent B reads agent A's context without re-querying LLM"
];
const r3 = await client.callTool({ name: "add_acceptance_criteria", arguments: { proposal_id: "231", criteria: p231acs } });
console.log("P231 ACs:", r3.content?.[0]?.text?.substring(0, 80));

// Register dependencies: P231 depends on P229 and P230
// (Token efficiency needs platform registry for routing + memory for context)
// P229 and P230 depend on P058 (Cubic orchestration — they integrate with dispatch)

await client.close();
console.log("Done — 21 ACs across 3 proposals");
