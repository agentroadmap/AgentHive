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
import { mcpText, parseMcpJson } from "./mcp-result.ts";
import { getPool, query } from "../src/infra/postgres/pool.ts";
import { spawnAgent } from "../src/core/orchestration/agent-spawner.ts";

const MCP_URL = "http://127.0.0.1:6421/sse";

const logger = {
  log: (...args: unknown[]) => console.log("[Orchestrator]", ...args),
  warn: (...args: unknown[]) => console.warn("[Orchestrator]", ...args),
  error: (...args: unknown[]) => console.error("[Orchestrator]", ...args),
};

// State → cubic phase mapping
const STATE_TO_PHASE: Record<string, string> = {
  DRAFT: "design",
  TRIAGE: "design",
  REVIEW: "design",
  FIX: "build",
  DEVELOP: "build",
  MERGE: "test",
  COMPLETE: "ship",
  DEPLOYED: "ship",
};

// Phase → model mapping (capability + cost optimized)
const PHASE_TO_MODEL: Record<string, string> = {
  design: "claude-opus-4-6",    // Deep reasoning for architecture, review, triage
  build: "claude-sonnet-4-6",   // Balanced code generation
  test: "gpt-4o",               // Integration testing
  ship: "claude-haiku-4-5",     // Low-cost documentation/finalization
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

// Parse MCP tool response safely — returns null if response is error text
function safeParseMcpResponse(text: string | undefined): any {
  if (!text) return null;
  // "No cubics found." is a valid empty result, not an error
  if (text.startsWith("No ") && text.endsWith("found.")) return { cubics: [] };
  if (text.startsWith("⚠️") || text.startsWith("Error") || text.startsWith("Failed")) {
    logger.warn(`MCP tool returned error: ${text.substring(0, 120)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    logger.warn(`MCP tool returned non-JSON: ${text.substring(0, 120)}`);
    return null;
  }
}

// Dispatch agent to cubic — ONE cubic per agent type, reused across proposals
async function dispatchAgent(agent: string, proposalId: string, task: string, phase: string): Promise<string | null> {
  const client = new Client({ name: "orchestrator", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));

  try {
    await client.connect(transport);

    // Step 1: Find existing cubic for this agent (locked OR idle)
    let cubicId: string | null = null;
    const existing = await client.callTool({ name: "cubic_list", arguments: {} });
    const data = safeParseMcpResponse(mcpText(existing));

    if (data?.cubics) {
      for (const cubic of data.cubics) {
        const agents = cubic.agents || [];
        if (agents.includes(agent)) {
          cubicId = cubic.id;
          break;
        }
      }
    }

    // Step 2: If cubic exists, release its lock first (may be working on old proposal)
    if (cubicId) {
      await client.callTool({
        name: "cubic_recycle",
        arguments: { cubicId, resetCode: false },
      });
      logger.log(`♻️ Recycled ${agent} cubic ${cubicId.substring(0, 8)}`);
    }

    // Step 3: Create new only if no cubic exists for this agent
    if (!cubicId) {
      const created = await client.callTool({
        name: "cubic_create",
        arguments: {
          name: `${agent}`,
          agents: [agent],
          proposals: [proposalId],
        },
      });
      const createdData = safeParseMcpResponse(mcpText(created));
      if (createdData?.success && createdData?.cubic?.id) {
        const newCubicId = String(createdData.cubic.id);
        cubicId = newCubicId;
        logger.log(`📦 New cubic ${newCubicId.substring(0, 8)} for ${agent}`);
      }
    }

    if (!cubicId) {
      logger.warn(`No cubic for ${agent} on P${proposalId}`);
      return null;
    }

    // Step 4: Focus with correct phase and model
    const model = PHASE_TO_MODEL[phase] || "claude-sonnet-4-6";
    await client.callTool({
      name: "cubic_focus",
      arguments: {
        cubicId,
        agent,
        task: `${AGENT_PROMPTS[agent] || ""} Proposal ${proposalId}: ${task}`,
        phase,
      },
    });

    logger.log(`🚀 ${agent} → ${cubicId.substring(0, 8)} | ${phase} | ${model} | P${proposalId}`);

    // Step 5: Actually spawn the agent process
    const taskPrompt = `${AGENT_PROMPTS[agent] || ""}\n\nProposal P${proposalId}: ${task}\n\nUse the MCP tools to do your work. Connect to http://127.0.0.1:6421/sse for proposal management.`;
    const result = await spawnAgent({
      worktree: "claude-one",
      task: taskPrompt,
      proposalId: Number(proposalId),
      stage: phase,
      model: model !== "claude-sonnet-4-6" ? model : undefined,
      timeoutMs: 600_000,
    });

    if (result.exitCode === 0) {
      logger.log(`✅ ${agent} completed (run=${result.agentRunId}) for P${proposalId}`);
    } else {
      logger.warn(`⚠️ ${agent} exited ${result.exitCode} (run=${result.agentRunId}) for P${proposalId}`);
    }

    return cubicId;

  } catch (err) {
    logger.error(`Dispatch failed for ${agent} on P${proposalId}:`, err);
    return null;
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

  const phase = STATE_TO_PHASE[newState] || "design";

  logger.log(`📢 P${proposalId} → ${newState} (${phase})`);
  logger.log(`   Squad: ${agents.join(", ")}`);

  // Release any locked cubics for this proposal from previous phases
  await releaseStaleCubics(proposalId);

  // Dispatch all agents for this state (parallel, tolerate individual failures)
  const results = await Promise.allSettled(
    agents.map(agent => dispatchAgent(agent, proposalId, `Handle ${newState}`, phase))
  );
  const dispatched = results.filter(r => r.status === "fulfilled" && r.value).length;
  logger.log(`   ${dispatched}/${agents.length} dispatched`);
}

// Release cubics that are still locked for a proposal that moved on
async function releaseStaleCubics(proposalId: string) {
  const client = new Client({ name: "orchestrator-cleanup", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));
  try {
    await client.connect(transport);
    const existing = await client.callTool({ name: "cubic_list", arguments: {} });
    const data = safeParseMcpResponse(mcpText(existing));
    if (!data?.cubics) return;

    for (const cubic of data.cubics) {
      const proposals = cubic.proposals || [];
      if (proposals.includes(Number(proposalId)) && cubic.lock) {
        await client.callTool({
          name: "cubic_transition",
          arguments: { cubicId: cubic.id, toPhase: "complete" },
        });
        logger.log(`🔓 Released ${cubic.name?.substring(0, 30)} (was locked for P${proposalId})`);
      }
    }
  } catch (err) {
    logger.warn("Cleanup error:", err);
  } finally {
    await client.close();
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
      
      // Get current state from workflows table
      const result = await query(
        "SELECT id, proposal_id, current_stage FROM roadmap.workflows WHERE proposal_id = $1 ORDER BY started_at DESC LIMIT 1",
        [proposalId]
      );

      if (result.rows.length > 0) {
        const wf = result.rows[0];
        await handleStateChange(String(wf.proposal_id), wf.current_stage);
      } else {
        // Fallback: check transition_queue for the latest stage info
        const tq = await query(
          "SELECT proposal_id, to_stage FROM roadmap.transition_queue WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1",
          [proposalId]
        );
        if (tq.rows.length > 0) {
          await handleStateChange(String(tq.rows[0].proposal_id), tq.rows[0].to_stage);
        }
      }
    } catch (e) {
      logger.error("Error handling notification:", e);
    }
  });
  
  // Poll for proposals needing agents (every 2 minutes)
  setInterval(async () => {
    try {
      // Find workflows in NEW states that haven't had agents dispatched yet
      // (workflows with no recent agent activity, ordered by recency)
      const result = await query(
        `SELECT w.id, w.proposal_id, w.current_stage
         FROM roadmap.workflows w
         WHERE w.completed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM roadmap.transition_queue tq
             WHERE tq.proposal_id = w.proposal_id
               AND tq.status IN ('pending', 'processing')
           )
         ORDER BY w.started_at DESC
         LIMIT 5`
      );

      for (const wf of result.rows) {
        await handleStateChange(String(wf.proposal_id), wf.current_stage);
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
