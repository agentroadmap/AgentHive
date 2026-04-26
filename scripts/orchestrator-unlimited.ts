/**
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
 * AgentHive Orchestrator — Event-driven agent dispatcher with UNLIMITED resources.
 * 
 * Dispatches agents immediately when state machine calls.
 * No cron schedules, no resource limits.
 * Multiple agents can run simultaneously.
 * 
 * When state changes:
 *   - DRAFT → Architect + Researcher
 *   - REVIEW → Reviewer + Skeptic Alpha + Skeptic Beta + Architecture Reviewer
 *   - DEVELOP → Developer + Skeptic Beta + Token Tracker
 *   - MERGE → Git Specialist + Messaging Tester
 *   - COMPLETE → Documenter + Pillar Researcher
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getPool, query } from "../src/infra/postgres/pool.ts";

const MCP_URL = getMcpUrl();

const logger = {
  log: (...args: unknown[]) => console.log("[Orchestrator]", ...args),
  warn: (...args: unknown[]) => console.warn("[Orchestrator]", ...args),
  error: (...args: unknown[]) => console.error("[Orchestrator]", ...args),
};

// UNLIMITED agent dispatch - no limits on how many agents can run
const AGENT_DISPATCH: Record<string, string[]> = {
  DRAFT: ["architect", "researcher", "system-monitor"],
  TRIAGE: ["triage-agent", "system-monitor", "researcher"],
  REVIEW: ["reviewer", "skeptic-alpha", "skeptic-beta", "architecture-reviewer", "pillar-researcher"],
  FIX: ["fix-agent", "developer", "token-tracker"],
  DEVELOP: ["developer", "skeptic-beta", "token-tracker", "messaging-tester"],
  MERGE: ["merge-agent", "git-specialist", "messaging-tester", "system-monitor"],
  COMPLETE: ["documenter", "pillar-researcher", "token-tracker"],
  DEPLOYED: ["system-monitor", "token-tracker", "pillar-researcher"],
};

// Track active agents (for monitoring, not limiting)
const activeAgents = new Map<string, Set<string>>();

// Dispatch agent to cubic (UNLIMITED)
async function dispatchAgent(agent: string, proposalId: string, task: string): Promise<void> {
  const client = new Client({ name: "orchestrator", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));
  
  try {
    await client.connect(transport);
    
    // Create new cubic for this agent (no reuse - unlimited)
    const created = await client.callTool({
      name: "cubic_create",
      arguments: {
        name: `${agent} — ${proposalId} — ${Date.now()}`,
        agents: [agent, "reviewer"],
        proposals: [proposalId],
      },
    });
    
    const data = JSON.parse(created.content?.[0]?.text || "{}");
    if (!data.success || !data.cubic) {
      logger.error(`Failed to create cubic for ${agent}`);
      return;
    }
    
    const cubicId = data.cubic.id;
    
    // Focus cubic (acquire lock)
    await client.callTool({
      name: "cubic_focus",
      arguments: {
        cubicId,
        agent,
        task: `Working on ${proposalId}: ${task}`,
        phase: "design",
      },
    });
    
    // Track active agent
    if (!activeAgents.has(proposalId)) {
      activeAgents.set(proposalId, new Set());
    }
    activeAgents.get(proposalId)?.add(agent);
    
    logger.log(`🚀 Dispatched ${agent} → ${cubicId} for ${proposalId}`);
    
  } catch (e) {
    logger.error(`Failed to dispatch ${agent}:`, e);
  } finally {
    await client.close();
  }
}

// Handle state change - dispatch ALL agents for this state
async function handleStateChange(proposalId: string, newState: string) {
  const agents = AGENT_DISPATCH[newState];
  
  if (!agents || agents.length === 0) {
    logger.log(`No agents for state: ${newState}`);
    return;
  }
  
  logger.log(`📢 State change: ${proposalId} → ${newState}`);
  logger.log(`   Dispatching ${agents.length} agents: ${agents.join(", ")}`);
  
  // Dispatch ALL agents in parallel (no limits)
  const promises = agents.map(agent => 
    dispatchAgent(agent, proposalId, `Handle ${newState}`)
  );
  
  await Promise.all(promises);
  
  logger.log(`✅ Dispatched ${agents.length} agents for ${proposalId}`);
}

// Main orchestrator
async function main() {
  logger.log("Starting Orchestrator with UNLIMITED agent dispatch...");
  
  const pool = getPool();
  const pgClient = await pool.connect();
  
  // Listen for ALL state changes
  await pgClient.query("LISTEN proposal_gate_ready");
  await pgClient.query("LISTEN proposal_maturity_changed");
  await pgClient.query("LISTEN transition_queued");
  await pgClient.query("LISTEN new_message");
  
  logger.log("Listening for state changes (unlimited agent dispatch)...");
  logger.log("Agent dispatch map:");
  for (const [state, agents] of Object.entries(AGENT_DISPATCH)) {
    logger.log(`  ${state}: ${agents.join(", ")}`);
  }
  
  // Handle notifications IMMEDIATELY (no batching)
  pgClient.on("notification", async (msg: { channel: string; payload?: string }) => {
    if (!msg.payload) return;
    
    try {
      const data = JSON.parse(msg.payload);
      const proposalId = data.proposal_id || data.id;
      
      if (!proposalId) return;
      
      // Get current state
      const result = await query(
        "SELECT id, display_id, status FROM roadmap.proposal WHERE id = $1",
        [proposalId]
      );
      
      if (result.rows.length > 0) {
        const proposal = result.rows[0];
        // Dispatch immediately - no waiting
        handleStateChange(proposalId, proposal.status);
      }
    } catch (e) {
      logger.error("Error handling notification:", e);
    }
  });
  
  // Poll every 30 seconds for proposals needing agents
  setInterval(async () => {
    try {
      const result = await query(
        `SELECT id, display_id, status 
         FROM roadmap.proposal 
         WHERE maturity_state = 'new' 
         ORDER BY priority DESC NULLS LAST 
         LIMIT 10`
      );
      
      for (const proposal of result.rows) {
        handleStateChange(proposal.id, proposal.status);
      }
    } catch (e) {
      logger.error("Polling error:", e);
    }
  }, 30 * 1000); // Every 30 seconds
  
  // Log active agents every 5 minutes
  setInterval(() => {
    const totalAgents = Array.from(activeAgents.values()).reduce((sum, set) => sum + set.size, 0);
    logger.log(`📊 Active agents: ${totalAgents} across ${activeAgents.size} proposals`);
  }, 5 * 60 * 1000);
  
  logger.log("Orchestrator running with UNLIMITED agent dispatch...");
  
  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down...`);
    pgClient.release();
    await pool.end();
    process.exit(0);
  };
  
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[Orchestrator] Fatal error:", err);
  process.exit(1);
});
