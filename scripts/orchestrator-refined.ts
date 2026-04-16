/**
 * AgentHive Orchestrator — Refined squad-based dispatch
 * 
 * Implements Gemini's recommendations for 100-agent fleet:
 * 
 * DRAFT: Strategic Synthesis Squad
 * TRIAGE: Issue Assessment Squad  
 * REVIEW: Skeptic Gauntlet
 * FIX: Fix & Validate Squad
 * DEVELOP: Implementation & Safety Squad
 * MERGE: Orchestrator Squad
 * COMPLETE: Documentation & Research Squad
 * DEPLOYED: Monitoring & Optimization Squad
 * 
 * Plus specialized agents:
 * - Inertia Detector (loop detection)
 * - Lease Renewer (claim management)
 * - Budget Circuit Breaker (financial oversight)
 * - Pillar Cross-Reviewer (inter-pillar integrity)
 * - Sync Auditor (Postgres-Git consistency)
 * - ROI Strategist (long-term optimization)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpText, parseMcpJson } from "./mcp-result.ts";
import { getPool, query } from "../src/infra/postgres/pool.ts";

const MCP_URL = "http://127.0.0.1:6421/sse";

const logger = {
  log: (...args: unknown[]) => console.log("[Orchestrator]", ...args),
  warn: (...args: unknown[]) => console.warn("[Orchestrator]", ...args),
  error: (...args: unknown[]) => console.error("[Orchestrator]", ...args),
};

// REFINED SQUAD DISPATCH MAP
const SQUAD_DISPATCH: Record<string, {
  agents: string[];
  description: string;
  specialized?: string[];
}> = {
  DRAFT: {
    agents: ["business-architect", "domain-researcher", "context-auditor"],
    description: "Strategic Synthesis Squad — delibreration before implementation",
    specialized: ["inertia-detector"],
  },
  TRIAGE: {
    agents: ["triage-agent", "system-monitor", "researcher"],
    description: "Issue Assessment Squad — evaluate and prioritize",
    specialized: ["lease-renewer"],
  },
  REVIEW: {
    agents: ["reviewer", "skeptic-alpha", "skeptic-beta", "architecture-reviewer", "pillar-cross-reviewer"],
    description: "Skeptic Gauntlet — adversarial analysis to prevent hallucination",
    specialized: ["inertia-detector", "budget-breaker"],
  },
  FIX: {
    agents: ["fix-agent", "developer", "token-tracker", "inertia-detector"],
    description: "Fix & Validate Squad — implement fixes with loop detection",
    specialized: ["lease-renewer", "budget-breaker"],
  },
  DEVELOP: {
    agents: ["developer", "skeptic-beta", "token-tracker", "messaging-tester", "pillar-developer", "test-mirror"],
    description: "Implementation & Safety Squad — write code with safety checks",
    specialized: ["inertia-detector", "budget-breaker", "lease-renewer", "sync-auditor"],
  },
  MERGE: {
    agents: ["merge-agent", "git-specialist", "e2e-orchestrator", "provenance-auditor"],
    description: "Orchestrator Squad — integrate and verify",
    specialized: ["sync-auditor", "budget-breaker"],
  },
  COMPLETE: {
    agents: ["documenter", "pillar-researcher", "token-tracker", "roi-strategist"],
    description: "Documentation & Research Squad — capture knowledge and optimize",
    specialized: ["sync-auditor"],
  },
  DEPLOYED: {
    agents: ["system-monitor", "token-tracker", "pillar-researcher", "roi-strategist"],
    description: "Monitoring & Optimization Squad — continuous improvement",
    specialized: ["budget-breaker"],
  },
};

// Track active agents and loops
const activeAgents = new Map<string, Set<string>>();
const attemptLog = new Map<string, number>();

// Check for inertia (same agent trying same thing repeatedly)
function checkInertia(proposalId: string, agent: string): boolean {
  const key = `${proposalId}:${agent}`;
  const attempts = attemptLog.get(key) || 0;
  
  if (attempts >= 3) {
    logger.warn(`🚨 INERTIA DETECTED: ${agent} stuck on ${proposalId} (${attempts} attempts)`);
    return true;
  }
  
  attemptLog.set(key, attempts + 1);
  return false;
}

// Dispatch agent to cubic
async function dispatchAgent(agent: string, proposalId: string, task: string): Promise<void> {
  // Check for inertia
  if (checkInertia(proposalId, agent)) {
    logger.warn(`Skipping ${agent} for ${proposalId} — inertia detected`);
    return;
  }
  
  const client = new Client({ name: "orchestrator", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));
  
  try {
    await client.connect(transport);
    
    // Create cubic
    const created = await client.callTool({
      name: "cubic_create",
      arguments: {
        name: `${agent} — ${proposalId} — ${Date.now()}`,
        agents: [agent, "reviewer"],
        proposals: [proposalId],
      },
    });
    
    const data = JSON.parse(mcpText(created) || "{}");
    if (!data.success || !data.cubic) {
      logger.error(`Failed to create cubic for ${agent}`);
      return;
    }
    
    const cubicId = data.cubic.id;
    
    // Focus cubic
    await client.callTool({
      name: "cubic_focus",
      arguments: {
        cubicId,
        agent,
        task: `Working on ${proposalId}: ${task}`,
        phase: "design",
      },
    });
    
    // Track
    if (!activeAgents.has(proposalId)) {
      activeAgents.set(proposalId, new Set());
    }
    activeAgents.get(proposalId)?.add(agent);
    
    logger.log(`🚀 ${agent} → ${cubicId} for ${proposalId}`);
    
  } catch (e) {
    logger.error(`Failed to dispatch ${agent}:`, e);
  } finally {
    await client.close();
  }
}

// Dispatch squad for state change
async function dispatchSquad(proposalId: string, newState: string) {
  const squad = SQUAD_DISPATCH[newState];
  
  if (!squad) {
    logger.log(`No squad for state: ${newState}`);
    return;
  }
  
  logger.log(`📢 ${proposalId} → ${newState} (${squad.description})`);
  logger.log(`   Squad: ${squad.agents.join(", ")}`);
  if (squad.specialized) {
    logger.log(`   Support: ${squad.specialized.join(", ")}`);
  }
  
  // Dispatch ALL agents in parallel
  const allAgents = [...squad.agents, ...(squad.specialized || [])];
  const promises = allAgents.map(agent => 
    dispatchAgent(agent, proposalId, squad.description)
  );
  
  await Promise.all(promises);
  
  logger.log(`✅ Dispatched ${allAgents.length} agents for ${proposalId}`);
}

// Main orchestrator
async function main() {
  logger.log("Starting Refined Orchestrator with Squad-based dispatch...");
  
  const pool = getPool();
  const pgClient = await pool.connect();
  
  // Listen for state changes
  await pgClient.query("LISTEN proposal_gate_ready");
  await pgClient.query("LISTEN proposal_maturity_changed");
  await pgClient.query("LISTEN transition_queued");
  await pgClient.query("LISTEN new_message");
  
  logger.log("Listening for state changes...");
  
  // Handle notifications
  pgClient.on("notification", async (msg: { channel: string; payload?: string }) => {
    if (!msg.payload) return;
    
    try {
      const data = JSON.parse(msg.payload);
      const proposalId = data.proposal_id || data.id;
      
      if (!proposalId) return;
      
      const result = await query(
        "SELECT id, display_id, status FROM roadmap.proposal WHERE id = $1",
        [proposalId]
      );
      
      if (result.rows.length > 0) {
        const proposal = result.rows[0];
        dispatchSquad(proposalId, proposal.status);
      }
    } catch (e) {
      logger.error("Error handling notification:", e);
    }
  });
  
  // Poll every 30 seconds
  setInterval(async () => {
    try {
      const result = await query(
        `SELECT id, display_id, status
         FROM roadmap_proposal.proposal
         WHERE maturity = 'new'
         ORDER BY priority DESC NULLS LAST 
         LIMIT 10`
      );
      
      for (const proposal of result.rows) {
        dispatchSquad(proposal.id, proposal.status);
      }
    } catch (e) {
      logger.error("Polling error:", e);
    }
  }, 30 * 1000);
  
  // Log squad status every 5 minutes
  setInterval(() => {
    const totalAgents = Array.from(activeAgents.values()).reduce((sum, set) => sum + set.size, 0);
    const totalAttempts = Array.from(attemptLog.values()).reduce((sum, count) => sum + count, 0);
    logger.log(`📊 Fleet Status: ${totalAgents} active agents, ${totalAttempts} attempts`);
  }, 5 * 60 * 1000);
  
  logger.log("Refined Orchestrator running with squad-based dispatch...");
  
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
