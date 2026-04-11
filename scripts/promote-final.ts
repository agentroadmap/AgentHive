import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = "http://127.0.0.1:6421/sse";

interface Promotion {
  id: string;
  criteria: string[];
}

const PROMOTIONS: Promotion[] = [
  {
    id: "P090",
    criteria: [
      "Phase 1 env vars (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50, MAX_THINKING_TOKENS, CLAUDE_CODE_SUBAGENT_MODEL) are documented and verified applied; migration 014 (metrics.token_efficiency + token_cache.semantic_responses tables) is deployed and verified",
      "Phase 2 prompt caching adds cache_control markers to static system prompt sections in the orchestration layer; first parallel request is serialized for cache warming",
      "Semantic cache stores responses with vector(1536) embeddings in token_cache.semantic_responses; ivfflat index created; cache hit rate measured and tracked via metrics.v_weekly_efficiency",
      "Phase 3 context compaction triggers at configurable percentage (default 50%); model routing selects appropriate model tier (Haiku/Sonnet/Opus) based on task complexity with Opus usage < 15%",
      "Weekly efficiency dashboard shows cache_hit_rate, avg_context_pct, opus_usage_pct, and cost_reduction_pct meeting targets (70%+ cache hit, 20% avg context, <15% Opus, 70% cost reduction)"
    ]
  },
  {
    id: "P082",
    criteria: [
      "addDependency handler in pg-handlers.ts calls DAGHealth.wouldCreateCycle() before INSERT; returns CYCLE_DETECTED error if true",
      "replaceDependencies in proposal-storage-v2.ts applies the same cycle guard before each edge insert",
      "PostgreSQL trigger (check_dependency_cycle) on proposal_dependencies INSERT runs a recursive CTE to detect cycles and raises an exception if found",
      "Integration tests verify cycle-creating edges are rejected, valid edges are accepted, and the database trigger rejects direct SQL cycle-creating INSERTs",
      "The erroneous reverse edge in the P045->P048 path is identified and removed; the correct P048 depends_on P045 edge is added; board view and queue ordering are verified correct"
    ]
  },
  {
    id: "P081",
    criteria: [
      "docs/sla-contract.md is created with defined SLA targets: p99 MCP tool call latency < 500ms, 99.5% monthly availability, RTO < 5 min, lease TTL 30 min default, degraded state trigger at >10% errors over 30s window, 100 concurrent agent baseline",
      "Platform state definitions (Normal, Degraded, Down) are documented with clear criteria for transitions between states",
      "health_check MCP tool returns current SLA state (Normal/Degraded/Down) with metric values",
      "Prometheus metrics at /metrics endpoint expose latency histogram, error rate counter, and availability gauge for observability integration (P063)",
      "Degraded state triggers notification to registered agents via the channel system; alerting thresholds are configurable per deployment"
    ]
  },
  {
    id: "P148",
    criteria: [
      "A CLI or MCP command (e.g. worktree_merge) merges a worktree branch back to main, handling conflicts gracefully",
      "Post-merge sync mechanism notifies or auto-rebases other active agents working on main",
      "Integration with proposal workflow: merge is triggered automatically at the Merge state transition",
      "Merge operation logs a clear audit trail in the proposal record",
      "Error handling: merge conflicts are reported back to the agent with actionable guidance rather than silently failing"
    ]
  }
];

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "draft-promoter-final", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  for (const promo of PROMOTIONS) {
    console.log(`${"=".repeat(60)}`);
    console.log(`Processing ${promo.id}...`);

    // Step 1: Transition to REVIEW
    console.log(`Transitioning ${promo.id} to REVIEW...`);
    try {
      const result = await client.callTool({
        name: "prop_transition",
        arguments: {
          id: promo.id,
          status: "REVIEW"
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") console.log(c.text);
      }
    } catch (err: any) {
      console.log("prop_transition error:", err.message);
    }

    // Step 2: Add acceptance criteria (as array)
    console.log(`Adding acceptance criteria to ${promo.id}...`);
    try {
      const result = await client.callTool({
        name: "add_acceptance_criteria",
        arguments: {
          proposal_id: promo.id,
          criteria: promo.criteria
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") console.log(c.text);
      }
    } catch (err: any) {
      console.log("add_acceptance_criteria error:", err.message);
    }
    console.log();
  }

  await client.close();
  console.log("Done.");
}

main().catch(console.error);
