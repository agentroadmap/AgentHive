import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = "http://127.0.0.1:6421/sse";

interface Promotion {
  id: string;
  summary: string;
}

const PROMOTIONS: Promotion[] = [
  {
    id: "P082",
    summary: `## Summary
Wire DAGHealth.wouldCreateCycle() into all dependency write paths and add a database-level safety net.

## Acceptance Criteria
1. AC-1: addDependency handler in pg-handlers.ts calls DAGHealth.wouldCreateCycle() before INSERT; returns CYCLE_DETECTED error if true.
2. AC-2: replaceDependencies in proposal-storage-v2.ts applies the same cycle guard before each edge insert.
3. AC-3: A PostgreSQL trigger (check_dependency_cycle) on proposal_dependencies INSERT runs a recursive CTE to detect cycles and raises an exception if found.
4. AC-4: Integration tests verify that (a) cycle-creating edges are rejected, (b) valid edges are accepted, and (c) the database trigger rejects direct SQL cycle-creating INSERTs.
5. AC-5: The erroneous reverse edge in the P045→P048 path is identified and removed; the correct P048 depends_on P045 edge is added; board view and queue ordering are verified correct.`
  },
  {
    id: "P090",
    summary: `## Summary
Implement three-tier token cost reduction: semantic cache, prompt caching, context management + model routing, targeting 80%+ combined savings.

## Acceptance Criteria
1. AC-1: Phase 1 env vars (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50, MAX_THINKING_TOKENS, CLAUDE_CODE_SUBAGENT_MODEL) are documented and verified applied; migration 014 (metrics.token_efficiency + token_cache.semantic_responses tables) is deployed and verified.
2. AC-2: Phase 2 prompt caching adds cache_control markers to static system prompt sections in the orchestration layer; first parallel request is serialized for cache warming.
3. AC-3: Semantic cache stores responses with vector(1536) embeddings in token_cache.semantic_responses; ivfflat index created; cache hit rate measured and tracked via metrics.v_weekly_efficiency.
4. AC-4: Phase 3 context compaction triggers at configurable percentage (default 50%); model routing selects appropriate model tier (Haiku/Sonnet/Opus) based on task complexity with Opus usage < 15%.
5. AC-5: Weekly efficiency dashboard shows cache_hit_rate, avg_context_pct, opus_usage_pct, and cost_reduction_pct meeting targets (70%+ cache hit, 20% avg context, <15% Opus, 70% cost reduction).`
  },
  {
    id: "P081",
    summary: `## Summary
Create a standalone SLA contract document defining measurable platform availability and performance targets.

## Acceptance Criteria
1. AC-1: docs/sla-contract.md is created with the defined SLA targets: p99 MCP tool call latency < 500ms, 99.5% monthly availability, RTO < 5 min, lease TTL 30 min default, degraded state trigger at >10% errors over 30s window, 100 concurrent agent baseline.
2. AC-2: Platform state definitions (Normal, Degraded, Down) are documented with clear criteria for transitions between states.
3. AC-3: health_check MCP tool returns current SLA state (Normal/Degraded/Down) with metric values.
4. AC-4: Prometheus metrics at /metrics endpoint expose latency (histogram), error rate (counter), and availability (gauge) for observability integration (P063).
5. AC-5: Degraded state triggers notification to registered agents via the channel system; alerting thresholds are configurable per deployment.`
  }
];

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "draft-promoter", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server\n");

  for (const promo of PROMOTIONS) {
    console.log(`${"=".repeat(60)}`);
    console.log(`Promoting ${promo.id} to REVIEW...`);
    try {
      const result = await client.callTool({
        name: "prop_update",
        arguments: {
          id: promo.id,
          status: "REVIEW",
          summary: promo.summary
        }
      });
      const content = result.content as any[];
      for (const c of content) {
        if (c.type === "text") {
          console.log(c.text);
        }
      }
      console.log(`Successfully promoted ${promo.id}\n`);
    } catch (err: any) {
      console.error(`Error promoting ${promo.id}:`, err.message, "\n");
    }
  }

  await client.close();
  console.log("Done.");
}

main().catch(console.error);
