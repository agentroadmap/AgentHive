/**
 * AgentHive Orchestrator — Event-driven agent dispatcher with dynamic agent deployment.
 * 
 * When state machine calls:
 *   - DRAFT → dispatch Architect to enhance
 *   - REVIEW → dispatch Reviewer + Skeptic to evaluate
 *   - DEVELOP → dispatch Developer to implement
 *   - MERGE → dispatch Git Specialist to integrate
 * 
 * Research & Architecture agents run on-demand when proposals need them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getPool, query } from "../src/infra/postgres/pool.ts";

const MCP_URL = "http://127.0.0.1:6421/sse";

const logger = {
  log: (...args: unknown[]) => console.log("[Orchestrator]", ...args),
  warn: (...args: unknown[]) => console.warn("[Orchestrator]", ...args),
  error: (...args: unknown[]) => console.error("[Orchestrator]", ...args),
};

// Agent dispatch map: state → agents to call
const AGENT_DISPATCH: Record<string, string[]> = {
  DRAFT: ["architect", "researcher"],
  TRIAGE: ["triage-agent", "system-monitor"],
  REVIEW: ["reviewer", "skeptic-alpha", "skeptic-beta", "architecture-reviewer"],
  FIX: ["fix-agent", "developer"],
  DEVELOP: ["developer", "skeptic-beta", "token-tracker"],
  MERGE: ["merge-agent", "git-specialist", "messaging-tester"],
  COMPLETE: ["documenter", "pillar-researcher"],
  DEPLOYED: ["system-monitor", "token-tracker"],
};

// Agent prompts
const AGENT_PROMPTS: Record<string, string> = {
  architect: "You are an Architecture Agent. Enhance this DRAFT proposal with acceptance criteria, design rationale, and implementation plan.",
  reviewer: "You are an RFC Reviewer. Evaluate this proposal for coherence, economic optimization, and structural soundness.",
  "skeptic-alpha": "You are SKEPTIC ALPHA. Challenge this proposal's design decisions. Demand evidence. Question assumptions.",
  "skeptic-beta": "You are SKEPTIC BETA. Review implementation quality. Check test coverage. Validate error handling.",
  "architecture-reviewer": "You are the Architecture Reviewer. Analyze design completeness, scalability, and integration constraints.",
  developer: "You are a Senior Developer. Implement all acceptance criteria. Write production code and tests.",
  "git-specialist": "You are a Git Specialist. Integrate branches, resolve conflicts, run tests.",
  "token-tracker": "You are the Token Efficiency Agent. Track usage, calculate costs, suggest optimizations.",
  "messaging-tester": "You are the Messaging Tester. Test A2A communication. Verify channel subscriptions.",
  "system-monitor": "You are the System Monitor. Spot inconsistencies. Make proposals for rectifications.",
  "pillar-researcher": "You are the Pillar Researcher. Research complementary components. Propose refinements.",
  documenter: "You are a Documenter. Write documentation for completed proposals.",
  researcher: "You are a Researcher. Gather context for proposals that need investigation.",
  "triage-agent": "You are a Triage Agent. Evaluate issues and decide what to work on.",
  "fix-agent": "You are a Fix Agent. Implement code changes to resolve issues.",
};

// Dispatch agent to cubic
async function dispatchAgent(agent: string, proposalId: string, task: string): Promise<string | null> {
  const client = new Client({ name: "orchestrator", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));
  
  try {
    await client.connect(transport);
    
    // Find or create cubic for this agent
    const existing = await client.callTool({ name: "cubic_list", arguments: {} });
    const data = JSON.parse(existing.content?.[0]?.text || "{}");
    
    let cubicId: string | null = null;
    
    // Look for existing cubic for this agent
    for (const cubic of data.cubics || []) {
      if (cubic.name?.toLowerCase().includes(agent.toLowerCase()) && !cubic.lock) {
        cubicId = cubic.id;
        break;
      }
    }
    
    // Create new cubic if needed
    if (!cubicId) {
      const created = await client.callTool({
        name: "cubic_create",
        arguments: {
          name: `${agent} — Working on ${proposalId}`,
          agents: [agent, "reviewer"],
          proposals: [proposalId],
        },
      });
      const createdData = JSON.parse(created.content?.[0]?.text || "{}");
      if (createdData.success && createdData.cubic) {
        cubicId = createdData.cubic.id;
      }
    }
    
    if (!cubicId) {
      logger.error(`Failed to create cubic for ${agent}`);
      return null;
    }
    
    // Focus cubic (acquire lock)
    const focused = await client.callTool({
      name: "cubic_focus",
      arguments: {
        cubicId,
        agent,
        task: `${AGENT_PROMPTS[agent] || ""} Working on: ${proposalId}. ${task}`,
        phase: "design",
      },
    });
    
    logger.log(`🚀 Dispatched ${agent} to ${cubicId} for ${proposalId}`);
    return cubicId;
    
  } finally {
    await client.close();
  }
}

// Handle state change and dispatch agents
async function handleStateChange(proposalId: string, newState: string) {
  const agents = AGENT_DISPATCH[newState];
  
  if (!agents || agents.length === 0) {
    logger.log(`No agents for state: ${newState}`);
    return;
  }
  
  logger.log(`📢 State change: ${proposalId} → ${newState}`);
  logger.log(`   Dispatching: ${agents.join(", ")}`);
  
  // Dispatch all agents for this state
  for (const agent of agents) {
    const task = `Handle ${newState} for ${proposalId}`;
    await dispatchAgent(agent, proposalId, task);
  }
}

// Main orchestrator
async function main() {
  logger.log("Starting Orchestrator with dynamic agent deployment...");
  
  const pool = getPool();
  const pgClient = await pool.connect();
  
  // Listen for state changes
  await pgClient.query("LISTEN proposal_gate_ready");
  await pgClient.query("LISTEN proposal_maturity_changed");
  await pgClient.query("LISTEN transition_queued");
  
  logger.log("Listening for state changes to dispatch agents...");
  
  // Handle notifications
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
        await handleStateChange(proposalId, proposal.status);
      }
    } catch (e) {
      logger.error("Error handling notification:", e);
    }
  });
  
  // Poll for proposals needing agents (every 2 minutes)
  setInterval(async () => {
    try {
      const result = await query(
        `SELECT id, display_id, status, maturity_state 
         FROM roadmap.proposal 
         WHERE maturity_state = 'new' 
         ORDER BY priority DESC NULLS LAST 
         LIMIT 5`
      );
      
      for (const proposal of result.rows) {
        await handleStateChange(proposal.id, proposal.status);
      }
    } catch (e) {
      logger.error("Polling error:", e);
    }
  }, 2 * 60 * 1000); // Every 2 minutes
  
  logger.log("Orchestrator running with dynamic agent deployment...");
  
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
